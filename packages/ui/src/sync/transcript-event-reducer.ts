/**
 * Pure transcript SSE reducer (Ticket 09 batch 2).
 *
 * Mutates a transcript-only draft (message/part maps). Production DirectoryStore
 * no longer carries these fields; Query/store adapters and tests own the draft.
 */
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { conversationIndexOf } from "./conversation-order"
import { syncDebug } from "./debug"
import type { DirectoryEventResult, SessionMaterializationReason } from "./event-reducer"

export type TranscriptEventDraft = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const DELTA_OVERLAP_FIELDS = ["text", "output"] as const
const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"])

type DedupeMetadata = {
  __dedupeNextDeltaFields?: string[]
}

function appendNonOverlappingDelta(existingValue: string | undefined, delta: string) {
  if (!existingValue || delta.length === 0) return (existingValue ?? "") + delta
  if (existingValue.endsWith(delta)) return existingValue

  const maxOverlap = Math.min(existingValue.length, delta.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existingValue.endsWith(delta.slice(0, overlap))) {
      return existingValue + delta.slice(overlap)
    }
  }

  return existingValue + delta
}

function getUpdatedDeltaFields(previous: Part, next: Part) {
  const dedupeFields: string[] = []
  for (const field of DELTA_OVERLAP_FIELDS) {
    const previousValue = (previous as Record<string, unknown>)[field]
    const nextValue = (next as Record<string, unknown>)[field]
    if (typeof previousValue !== "string" || typeof nextValue !== "string") continue
    if (previousValue.length === 0 || nextValue.length === 0) continue
    if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
      dedupeFields.push(field)
    }
  }
  return dedupeFields
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getToolStatus(part: Part): string | undefined {
  if (part.type !== "tool") {
    return undefined
  }

  const status = (part as { state?: { status?: unknown } }).state?.status
  return typeof status === "string" ? status : undefined
}

function shouldPreserveExistingPart(previous: Part, next: Part): boolean {
  if (previous.type !== "tool" || next.type !== "tool") {
    return false
  }

  const previousStatus = getToolStatus(previous)
  const nextStatus = getToolStatus(next)
  if (previousStatus && FINAL_TOOL_STATUSES.has(previousStatus) && (!nextStatus || !FINAL_TOOL_STATUSES.has(nextStatus))) {
    return true
  }

  const previousEnd = getPartEndTime(previous)
  const nextEnd = getPartEndTime(next)
  if (typeof previousEnd === "number" && typeof nextEnd !== "number") {
    return true
  }

  return false
}

function areJsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return left === right
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function areMessageUpdateFieldsEqual(existing: Message, next: Message): boolean {
  if (existing.role !== next.role) return false
  if ((existing as { finish?: unknown }).finish !== (next as { finish?: unknown }).finish) return false
  if ((existing.time as { completed?: number })?.completed !== (next.time as { completed?: number })?.completed) return false

  const fields: Array<keyof Message | "structured" | "summary" | "tokens" | "error" | "cost" | "model" | "tools" | "format" | "variant" | "agent" | "system"> = [
    "summary",
    "error",
    "cost",
    "tokens",
    "structured",
    "model",
    "tools",
    "format",
    "variant",
    "agent",
    "system",
  ]

  for (const field of fields) {
    if (!areJsonEquivalent((existing as Record<string, unknown>)[field], (next as Record<string, unknown>)[field])) {
      return false
    }
  }

  return true
}

function hasMessage(draft: TranscriptEventDraft, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  return conversationIndexOf(messages, messageID) >= 0
}

/**
 * Apply a transcript SSE event to a pure message/part draft.
 * Non-transcript events return false without mutation.
 */
export function applyTranscriptDirectoryEvent(
  draft: TranscriptEventDraft,
  event: Event,
): DirectoryEventResult {
  switch (event.type) {
    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      const messages = draft.message[info.sessionID]
      const sessionWasRenderable = Boolean(messages) && messages.every(
        (message) => message.role !== "assistant" || draft.part[message.id] !== undefined,
      )
      if (info.role === "assistant" && sessionWasRenderable && draft.part[info.id] === undefined) {
        draft.part[info.id] = []
      }
      if (!messages) {
        draft.message[info.sessionID] = [info]
        return true
      }
      const index = conversationIndexOf(messages, info.id)
      if (index >= 0) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[index]
        const unchanged = areMessageUpdateFieldsEqual(existing, info)
        if (unchanged) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, (info as { finish?: unknown }).finish, (info.time as { completed?: number })?.completed)
          return false
        }
        const next = [...messages]
        next[index] = info
        draft.message[info.sessionID] = next
      } else {
        draft.message[info.sessionID] = [...messages, info]
      }
      return true
    }

    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      const messages = draft.message[props.sessionID]
      if (messages) {
        const index = conversationIndexOf(messages, props.messageID)
        if (index >= 0) {
          const next = [...messages]
          next.splice(index, 1)
          draft.message[props.sessionID] = next
        }
      }
      delete draft.part[props.messageID]
      return true
    }

    case "message.part.updated": {
      const props = event.properties as { sessionID?: string; part: Part }
      const part = props.part
      if (SKIP_PARTS.has(part.type)) {
        syncDebug.reducer.partSkipped((part as { messageID: string }).messageID, part.id, part.type)
        return false
      }
      const messageID = (part as { messageID?: string }).messageID
      const sessionID = props.sessionID ?? (part as { sessionID?: string }).sessionID
      if (!messageID) return false
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, part.type)
        draft.part[messageID] = [part]
        return missingOwningMessage
          ? {
            changed: true,
            materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
          }
          : true
      }
      const next = [...parts]
      const result = Binary.search(next, part.id, (p) => p.id)
      if (result.found) {
        const previous = next[result.index]
        if (shouldPreserveExistingPart(previous, part)) {
          return false
        }
        const dedupeFields = getUpdatedDeltaFields(previous, part)
        next[result.index] = dedupeFields.length > 0
          ? { ...part, __dedupeNextDeltaFields: dedupeFields } as unknown as Part
          : part
      } else {
        // Replace the matching local optimistic part with the server-owned part.
        // Optimistic parts carry real session IDs, so sessionID cannot distinguish
        // them from authoritative parts. The local-only marker is set at insertion
        // time and disappears when this replacement writes the server part.
        const optimisticIdx = (part.type === "text" || part.type === "file")
          ? next.findIndex((p) => p.type === part.type && (p as { __openchamberOptimistic?: boolean }).__openchamberOptimistic === true)
          : -1
        if (optimisticIdx >= 0) {
          next.splice(optimisticIdx, 1)
        }
        const insertResult = Binary.search(next, part.id, (p) => p.id)
        next.splice(insertResult.index, 0, part)
      }
      draft.part[messageID] = next
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
        }
        : true
    }

    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = draft.part[props.messageID]
      if (!parts) return false
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        const next = [...parts]
        next.splice(result.index, 1)
        if (next.length === 0) {
          delete draft.part[props.messageID]
        } else {
          draft.part[props.messageID] = next
        }
        return true
      }
      return false
    }

    case "message.part.delta": {
      const props = event.properties as {
        sessionID?: string
        messageID: string
        partID: string
        field: string
        delta: string
      }
      const parts = draft.part[props.messageID]
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: props.sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) {
        syncDebug.reducer.partDeltaNotFound(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", sessionID: props.sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      const existing = parts[result.index] as Record<string, unknown>
      const existingValue = existing[props.field] as string | undefined
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(props.field)
      // Create new Part object + new array so React detects the change
      const next = [...parts]
      next[result.index] = {
        ...existing,
        [props.field]: shouldDedupe ? appendNonOverlappingDelta(existingValue, props.delta) : (existingValue ?? "") + props.delta,
        __dedupeNextDeltaFields: dedupeFields.filter((field) => field !== props.field),
      } as unknown as Part
      draft.part[props.messageID] = next
      return true
    }
    default:
      return false
  }
}

export type { SessionMaterializationReason }
