/**
 * Pure transcript SSE reducer (Ticket 09 batch 2).
 *
 * Mutates a transcript-only draft (message/part maps). Production DirectoryStore
 * no longer carries these fields; Query/store adapters and tests own the draft.
 */
import type { Message, Part } from '@/lib/opencode/v2-types'
import type { Event } from '@/sync/types'

import { Binary } from "./binary"
import { conversationIndexOf } from "./conversation-order"
import { syncDebug } from "./debug"
import type { DirectoryEventResult, SessionMaterializationReason } from "./event-reducer"
import { applySessionCompactionLiveEvent } from "./session-compaction-api"
import {
  messageIDFromEventID,
  normalizeProjectionToolName,
  normalizeSessionProjectionMessage,
} from "./session-projection-api"

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

// String identity only. `model` is an object (UserMessage since OpenCode 1.4.0
// carries providerID/modelID/variant there) and must not use readNonEmptyString.
const MESSAGE_IDENTITY_FIELDS = ["agent", "mode", "providerID", "modelID", "variant"] as const

const isObjectModelRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const TOKEN_COUNT_FIELDS = ["input", "output", "reasoning"] as const

export function hasAnyPositiveTokenCount(tokens: unknown): boolean {
  if (!tokens || typeof tokens !== "object") return false
  const record = tokens as Record<string, unknown>
  return TOKEN_COUNT_FIELDS.some(
    (field) => typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] > 0,
  )
}

function isZeroTokenRecord(tokens: unknown): boolean {
  if (!tokens || typeof tokens !== "object") return false
  const record = tokens as Record<string, unknown>
  return TOKEN_COUNT_FIELDS.every(
    (field) => typeof record[field] !== "number" || !Number.isFinite(record[field]) || record[field] <= 0,
  )
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Merge an incoming message payload into the stored one while preserving
 * agent/model identity fields the payload omitted. Runtime `message.updated`
 * ticks (tokens/cost/finish) carry identity only on the first publish of a
 * message; a wholesale replace there blanks the assistant header until the
 * next step publishes identity again.
 */
export function mergeTranscriptMessageUpdate(existing: Message, incoming: Message): Message {
  const merged = { ...existing, ...incoming } as Message
  const existingRecord = existing as Record<string, unknown>
  const incomingRecord = incoming as Record<string, unknown>
  const mergedRecord = merged as Record<string, unknown>

  for (const field of MESSAGE_IDENTITY_FIELDS) {
    const next = readNonEmptyString(incomingRecord[field])
    const previous = readNonEmptyString(existingRecord[field])
    if (next) {
      mergedRecord[field] = next
    } else if (previous) {
      mergedRecord[field] = previous
    } else {
      delete mergedRecord[field]
    }
  }

  // Object-level `model` retention. Incoming wins as a whole when present;
  // otherwise keep existing. Treating `model` like a string identity field
  // deleted the object on every SSE message.updated (readNonEmptyString →
  // undefined → delete), which dropped UserMessage.model.variant and hid the
  // live thinking-intensity badge until a cold insert-only reload.
  const incomingModel = incomingRecord.model
  const existingModel = existingRecord.model
  if (isObjectModelRecord(incomingModel)) {
    mergedRecord.model = incomingModel
  } else if (isObjectModelRecord(existingModel)) {
    mergedRecord.model = existingModel
  } else {
    delete mergedRecord.model
  }

  if (existing.time || incoming.time) {
    merged.time = { ...existing.time, ...incoming.time }
  }

  // Token counts accumulate per message and never regress. OpenCode stamps an
  // assistant message with an all-zero `tokens` object from creation, so a
  // mid-turn HTTP snapshot (materialize / recovery / reconcile upsert) that
  // resolves after the settle ticks would otherwise blank the final counts —
  // the settled message keeps its zero-token placeholder and derived display
  // (assistant TPS) stays missing until the next full authority refresh.
  if (hasAnyPositiveTokenCount(existingRecord.tokens) && isZeroTokenRecord(incomingRecord.tokens)) {
    mergedRecord.tokens = existingRecord.tokens
  }

  return merged
}

function areMessageUpdateFieldsEqual(existing: Message, next: Message): boolean {
  if (existing.time.streamed !== next.time.streamed) return false
  if (existing.role !== next.role) return false
  if ((existing as { finish?: unknown }).finish !== (next as { finish?: unknown }).finish) return false
  if ((existing.time as { completed?: number })?.completed !== (next.time as { completed?: number })?.completed) return false

  const fields: Array<keyof Message | "structured" | "summary" | "tokens" | "error" | "cost" | "model" | "tools" | "format" | "variant" | "agent" | "system" | "mode" | "providerID" | "modelID"> = [
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
    "mode",
    "providerID",
    "modelID",
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
      // v2 control rows (idle / model-switched / …) must not enter the live
      // transcript; they render as empty Assistant headers after reload.
      const wireExtras = info as Record<string, unknown>
      const controlType = typeof wireExtras.type === "string" ? wireExtras.type : undefined
      const controlRole = typeof wireExtras.role === "string" ? wireExtras.role : undefined
      if (
        controlType === "idle"
        || controlType === "model-switched"
        || controlType === "agent-selected"
        || controlType === "agent-switched"
        || controlType === "location-switched"
        || controlRole === "idle"
      ) {
        return false
      }
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
        const merged = mergeTranscriptMessageUpdate(existing, info)
        const unchanged = areMessageUpdateFieldsEqual(existing, merged)
        if (unchanged) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, (info as { finish?: unknown }).finish, (info.time as { completed?: number })?.completed)
          return false
        }
        const next = [...messages]
        next[index] = merged
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
      return applyV2LiveOverlay(draft, event)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function projectionPartID(messageID: string, type: string, ordinal: number): string {
  return `${messageID}:${type}:${ordinal}`
}

type AssistantBootstrapMeta = {
  /** Envelope wall-clock (`eventCreated`) or other positive created ms. */
  created?: number
  agent?: string
  modelID?: string
  providerID?: string
  variant?: string
  model?: { providerID?: string; modelID?: string; variant?: string }
}

/**
 * Resolve a positive created timestamp for live assistant rows.
 * `created: 0` breaks turn attribution: projectTurnRecords falls back to
 * time order and treats 0 as earlier than every real user turn, so the live
 * assistant is dropped from the turn tree.
 */
function resolveAssistantCreatedTime(meta?: AssistantBootstrapMeta): number {
  if (typeof meta?.created === "number" && Number.isFinite(meta.created) && meta.created > 0) {
    return meta.created
  }
  return Date.now()
}

function readEventCreated(props: Record<string, unknown>): number | undefined {
  const value = props.eventCreated
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function ensureAssistantMessage(
  draft: TranscriptEventDraft,
  sessionID: string,
  messageID: string,
  meta?: AssistantBootstrapMeta,
): boolean {
  const messages = draft.message[sessionID]
  const index = messages ? conversationIndexOf(messages, messageID) : -1
  if (index >= 0 && messages) {
    // Repair placeholder rows created before step.started carried real metadata.
    const existing = messages[index]!
    const existingCreated = existing.time?.created
    let changed = false
    const next = { ...existing, time: { ...existing.time } } as Message
    if (
      (existingCreated === undefined || existingCreated <= 0)
      && typeof meta?.created === "number"
      && meta.created > 0
    ) {
      next.time = { ...next.time, created: meta.created }
      changed = true
    }
    if (!readNonEmptyString((existing as { agent?: unknown }).agent) && meta?.agent) {
      next.agent = meta.agent
      changed = true
    }
    if (!readNonEmptyString((existing as { modelID?: unknown }).modelID) && meta?.modelID) {
      next.modelID = meta.modelID
      changed = true
    }
    if (!readNonEmptyString((existing as { providerID?: unknown }).providerID) && meta?.providerID) {
      next.providerID = meta.providerID
      changed = true
    }
    if (!readNonEmptyString((existing as { variant?: unknown }).variant) && meta?.variant) {
      next.variant = meta.variant
      changed = true
    }
    if (!(existing as { model?: unknown }).model && meta?.model) {
      next.model = meta.model
      changed = true
    }
    if (!changed) return false
    const nextMessages = [...messages]
    nextMessages[index] = next
    draft.message[sessionID] = nextMessages
    return true
  }
  const info = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: resolveAssistantCreatedTime(meta) },
    ...(meta?.agent ? { agent: meta.agent } : {}),
    ...(meta?.modelID ? { modelID: meta.modelID } : {}),
    ...(meta?.providerID ? { providerID: meta.providerID } : {}),
    ...(meta?.variant ? { variant: meta.variant } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
  } as Message
  draft.message[sessionID] = messages ? [...messages, info] : [info]
  return true
}

function modelMetaFromStep(props: Record<string, unknown>): AssistantBootstrapMeta {
  const agent = asString(props.agent)
  const model = asRecord(props.model)
  const modelID = model ? asString(model.id) ?? asString(model.modelID) : undefined
  const providerID = model ? asString(model.providerID) : undefined
  const variant = model ? asString(model.variant) : undefined
  return {
    ...(agent ? { agent } : {}),
    ...(modelID ? { modelID } : {}),
    ...(providerID ? { providerID } : {}),
    ...(variant ? { variant } : {}),
    ...(modelID || providerID || variant
      ? {
        model: {
          ...(providerID ? { providerID } : {}),
          ...(modelID ? { modelID } : {}),
          ...(variant ? { variant } : {}),
        },
      }
      : {}),
  }
}

function readTokenUsage(value: unknown): Message["tokens"] | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const cache = asRecord(record.cache)
  const tokens: NonNullable<Message["tokens"]> = {
    ...(typeof record.input === "number" ? { input: record.input } : {}),
    ...(typeof record.output === "number" ? { output: record.output } : {}),
    ...(typeof record.reasoning === "number" ? { reasoning: record.reasoning } : {}),
    ...(cache
      ? {
        cache: {
          ...(typeof cache.read === "number" ? { read: cache.read } : {}),
          ...(typeof cache.write === "number" ? { write: cache.write } : {}),
        },
      }
      : {}),
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined
}

function patchAssistantMessage(
  draft: TranscriptEventDraft,
  sessionID: string,
  messageID: string,
  patch: Message,
): boolean {
  const messages = draft.message[sessionID]
  if (!messages) {
    draft.message[sessionID] = [patch]
    return true
  }
  const index = conversationIndexOf(messages, messageID)
  if (index < 0) {
    draft.message[sessionID] = [...messages, patch]
    return true
  }
  const existing = messages[index]!
  const merged = mergeTranscriptMessageUpdate(existing, patch)
  if (areMessageUpdateFieldsEqual(existing, merged) && existing.time?.created === merged.time?.created) {
    return false
  }
  const next = [...messages]
  next[index] = merged
  draft.message[sessionID] = next
  return true
}

function existingAssistantCreated(
  draft: TranscriptEventDraft,
  sessionID: string,
  messageID: string,
): number | undefined {
  const messages = draft.message[sessionID]
  if (!messages) return undefined
  const index = conversationIndexOf(messages, messageID)
  if (index < 0) return undefined
  const created = messages[index]?.time?.created
  return typeof created === "number" && Number.isFinite(created) && created > 0 ? created : undefined
}

function applyStepLifecycle(
  draft: TranscriptEventDraft,
  type: string,
  sessionID: string,
  messageID: string,
  props: Record<string, unknown>,
): boolean {
  const eventCreated = readEventCreated(props)
  if (type === "session.step.started") {
    return ensureAssistantMessage(draft, sessionID, messageID, {
      created: eventCreated,
      ...modelMetaFromStep(props),
    })
  }
  if (type === "session.step.streamed") {
    if (!eventCreated) return false
    ensureAssistantMessage(draft, sessionID, messageID, { created: eventCreated })
    return patchAssistantMessage(draft, sessionID, messageID, {
      id: messageID, sessionID, role: "assistant",
      time: { created: existingAssistantCreated(draft, sessionID, messageID) ?? eventCreated, streamed: eventCreated },
    })
  }
  if (type === "session.step.ended") {
    ensureAssistantMessage(draft, sessionID, messageID, { created: eventCreated })
    const finish = asString(props.finish)
    const tokens = readTokenUsage(props.tokens)
    const cost = typeof props.cost === "number" && Number.isFinite(props.cost) ? props.cost : undefined
    const created = existingAssistantCreated(draft, sessionID, messageID)
      ?? resolveAssistantCreatedTime({ created: eventCreated })
    const patch = {
      id: messageID,
      sessionID,
      role: "assistant",
      time: {
        created,
        ...(eventCreated ? { completed: eventCreated } : {}),
      },
      ...(finish ? { finish } : {}),
      ...(tokens ? { tokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
    } as Message
    return patchAssistantMessage(draft, sessionID, messageID, patch)
  }
  if (type === "session.step.failed") {
    ensureAssistantMessage(draft, sessionID, messageID, { created: eventCreated })
    const error = asRecord(props.error)
    const tokens = readTokenUsage(props.tokens)
    const cost = typeof props.cost === "number" && Number.isFinite(props.cost) ? props.cost : undefined
    const created = existingAssistantCreated(draft, sessionID, messageID)
      ?? resolveAssistantCreatedTime({ created: eventCreated })
    const patch = {
      id: messageID,
      sessionID,
      role: "assistant",
      time: {
        created,
        ...(eventCreated ? { completed: eventCreated } : {}),
      },
      finish: "error",
      ...(error
        ? {
          error: {
            type: asString(error.type) ?? "error",
            message: asString(error.message) ?? "",
            ...(typeof error.status === "number" ? { status: error.status } : {}),
          },
        }
        : asString(props.error)
          ? { error: { type: "error", message: asString(props.error)! } }
          : {}),
      ...(tokens ? { tokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
    } as Message
    return patchAssistantMessage(draft, sessionID, messageID, patch)
  }
  return false
}

function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  return content
    .flatMap((item) => {
      const record = asRecord(item)
      return record && record.type === "text" && typeof record.text === "string" ? [record.text] : []
    })
    .join("\n")
}

function findTypedPart(
  parts: Part[],
  type: "text" | "reasoning",
  messageID: string,
  ordinal: number,
): number {
  const id = projectionPartID(messageID, type, ordinal)
  const byID = parts.findIndex((part) => part.id === id)
  if (byID >= 0) return byID
  const typed = parts
    .map((part, index) => ({ part, index }))
    .filter((entry) => entry.part.type === type)
  return typed[ordinal]?.index ?? -1
}

function upsertTextLikePart(
  draft: TranscriptEventDraft,
  sessionID: string,
  messageID: string,
  type: "text" | "reasoning",
  ordinal: number,
  nextText: string | ((current: string) => string),
  meta?: AssistantBootstrapMeta,
): boolean {
  ensureAssistantMessage(draft, sessionID, messageID, meta)
  const parts = draft.part[messageID] ? [...draft.part[messageID]!] : []
  let index = findTypedPart(parts, type, messageID, ordinal)
  if (index < 0) {
    const part = {
      id: projectionPartID(messageID, type, ordinal),
      sessionID,
      messageID,
      type,
      text: "",
    } as Part
    parts.push(part)
    index = parts.length - 1
  }
  const current = parts[index] as Part & { text?: string }
  const text = typeof nextText === "function" ? nextText(current.text ?? "") : nextText
  parts[index] = { ...current, text } as Part
  draft.part[messageID] = parts
  return true
}

function findToolIndex(parts: Part[], toolID: string): number {
  return parts.findIndex((part) => (
    part.id === toolID
    || (part as { callID?: string }).callID === toolID
    || (part.type === "tool" && part.id === toolID)
  ))
}

function upsertToolPart(
  draft: TranscriptEventDraft,
  sessionID: string,
  messageID: string,
  toolID: string,
  name: string | undefined,
  update: (part: Part) => Part,
  meta?: AssistantBootstrapMeta,
): boolean {
  ensureAssistantMessage(draft, sessionID, messageID, meta)
  const parts = draft.part[messageID] ? [...draft.part[messageID]!] : []
  let index = findToolIndex(parts, toolID)
  if (index < 0) {
    parts.push({
      id: toolID,
      sessionID,
      messageID,
      type: "tool",
      tool: normalizeProjectionToolName(name) ?? "tool",
      callID: toolID,
      state: { status: "pending", input: "", output: undefined, metadata: {} },
    } as Part)
    index = parts.length - 1
  }
  parts[index] = update(parts[index]!)
  draft.part[messageID] = parts
  return true
}

/** Shell cards are keyed by upstream shell identity, not by the event's message ID. */
export function findShellMessageID(
  draft: TranscriptEventDraft,
  sessionID: string,
  shellID: string,
): string | undefined {
  return draft.message[sessionID]?.find((message) => draft.part[message.id]?.some(
    (part) => part.type === "text" && part.shellAction?.shellID === shellID,
  ))?.id
}

/**
 * Overlay official v2 live events onto the existing Message+Part draft.
 * Deltas are incremental; they are not treated as replayable history.
 */
function applyV2LiveOverlay(draft: TranscriptEventDraft, event: Event): DirectoryEventResult {
  const type = String(event.type)
  if (type.startsWith("session.compaction.")) {
    return applySessionCompactionLiveEvent(draft, event)
  }
  const props = asRecord(event.properties)
  if (!props) return false
  const sessionID = asString(props.sessionID)
  if (sessionID && (type === "session.shell.started" || type === "session.shell.ended")) {
    const shell = asRecord(props.shell)
    const shellID = asString(shell?.id)
    if (!shell || !shellID) return false
    const messages = draft.message[sessionID] ?? []
    const existingID = findShellMessageID(draft, sessionID, shellID)
    const existing = existingID ? messages.find((message) => message.id === existingID) : undefined
    // End events carry shell identity; a missed start is recovered by the terminal GET.
    const id = existing?.id ?? (type === "session.shell.started" ? messageIDFromEventID(event.id) : undefined)
    if (!id) return false
    if (type === "session.shell.started" && existing) return false
    const row = normalizeSessionProjectionMessage(sessionID, {
      id, type: "shell", shellID, command: shell.command, status: shell.status, exit: shell.exit,
      output: props.output,
      time: { created: existing?.time.created ?? readEventCreated(props),
        ...(type === "session.shell.ended" ? { completed: readEventCreated(props) } : {}) },
    })
    if (!row) return false
    if (existing && areJsonEquivalent(existing, row.info) && areJsonEquivalent(draft.part[id], row.parts)) return false
    draft.message[sessionID] = existing ? messages.map((message) => message.id === id ? row.info : message) : [...messages, row.info]
    draft.part[id] = row.parts
    return true
  }
  // Official session.synthetic → same normalize rule as GET projection rows.
  if (sessionID && type === "session.synthetic") {
    const id = messageIDFromEventID(event.id)
    if (!id) return false
    const row = normalizeSessionProjectionMessage(sessionID, {
      id,
      type: "synthetic",
      text: props.text,
      description: props.description,
      metadata: props.metadata,
      time: { created: readEventCreated(props) },
    })
    if (!row) return false
    const messages = draft.message[sessionID] ?? []
    const existing = messages.find((message) => message.id === id)
    if (existing && areJsonEquivalent(existing, row.info) && areJsonEquivalent(draft.part[id], row.parts)) {
      return false
    }
    draft.message[sessionID] = existing
      ? messages.map((message) => (message.id === id ? row.info : message))
      : [...messages, row.info]
    draft.part[id] = row.parts
    return true
  }
  // Revert commit range is owned by merge `revert-committed` (with read epoch).
  // Keep the SSE type recognized so batch routing reaches the repository.
  if (type === "session.revert.committed") {
    return false
  }
  const messageID = asString(props.assistantMessageID)
  if (!sessionID || !messageID) return false
  const ordinal = typeof props.ordinal === "number" ? props.ordinal : 0
  const bootstrap: AssistantBootstrapMeta = { created: readEventCreated(props) }

  // Official step lifecycle carries finish/cost/tokens and identity metadata.
  if (type === "session.step.started" || type === "session.step.streamed" || type === "session.step.ended" || type === "session.step.failed") {
    return applyStepLifecycle(draft, type, sessionID, messageID, props)
  }

  if (type === "session.text.started") {
    return upsertTextLikePart(draft, sessionID, messageID, "text", ordinal, "", bootstrap)
  }
  if (type === "session.text.delta") {
    const delta = typeof props.delta === "string" ? props.delta : ""
    if (!delta) return false
    return upsertTextLikePart(draft, sessionID, messageID, "text", ordinal, (current) => current + delta, bootstrap)
  }
  if (type === "session.text.ended") {
    const text = typeof props.text === "string" ? props.text : ""
    return upsertTextLikePart(draft, sessionID, messageID, "text", ordinal, text, bootstrap)
  }
  if (type === "session.reasoning.started") {
    return upsertTextLikePart(draft, sessionID, messageID, "reasoning", ordinal, "", bootstrap)
  }
  if (type === "session.reasoning.delta") {
    const delta = typeof props.delta === "string" ? props.delta : ""
    if (!delta) return false
    return upsertTextLikePart(draft, sessionID, messageID, "reasoning", ordinal, (current) => current + delta, bootstrap)
  }
  if (type === "session.reasoning.ended") {
    const text = typeof props.text === "string" ? props.text : ""
    return upsertTextLikePart(draft, sessionID, messageID, "reasoning", ordinal, text, bootstrap)
  }

  const toolID = asString(props.id)
  if (!toolID) return false
  const name = asString(props.name)

  if (type === "session.tool.input.started") {
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => part, bootstrap)
  }
  if (type === "session.tool.input.delta") {
    const delta = typeof props.delta === "string" ? props.delta : ""
    if (!delta) return false
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      if (asString(state.status) && state.status !== "pending" && state.status !== "streaming") {
        return part
      }
      const input = typeof state.input === "string" ? state.input + delta : delta
      return { ...part, state: { ...state, status: "pending", input } } as Part
    }, bootstrap)
  }
  if (type === "session.tool.input.ended") {
    const text = typeof props.text === "string" ? props.text : ""
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      return { ...part, state: { ...state, input: text } } as Part
    }, bootstrap)
  }
  if (type === "session.tool.called") {
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      return {
        ...part,
        state: {
          ...state,
          status: "pending",
          input: props.input ?? state.input ?? {},
          metadata: asRecord(state.metadata) ?? {},
        },
      } as Part
    }, bootstrap)
  }
  if (type === "session.tool.progress") {
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      return {
        ...part,
        state: { ...state, metadata: asRecord(props.metadata) ?? asRecord(state.metadata) ?? {} },
      } as Part
    }, bootstrap)
  }
  if (type === "session.tool.success") {
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      return {
        ...part,
        state: {
          ...state,
          status: "completed",
          input: state.input ?? props.input ?? {},
          output: toolOutput(props.content),
          metadata: asRecord(props.metadata) ?? asRecord(state.metadata) ?? {},
        },
      } as Part
    }, bootstrap)
  }
  if (type === "session.tool.failed") {
    return upsertToolPart(draft, sessionID, messageID, toolID, name, (part) => {
      const state = asRecord((part as { state?: unknown }).state) ?? {}
      const error = asRecord(props.error)
      return {
        ...part,
        state: {
          ...state,
          status: "error",
          input: state.input ?? {},
          output: toolOutput(props.content),
          error: error ? asString(error.message) ?? asString(props.error) : asString(props.error),
          metadata: asRecord(props.metadata) ?? asRecord(state.metadata) ?? {},
        },
      } as Part
    }, bootstrap)
  }
  return false
}

export type { SessionMaterializationReason }
