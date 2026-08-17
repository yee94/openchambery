/**
 * Production parent-message recovery helpers (Ticket 09 batch 2).
 *
 * Extracted from session-message-loader so production Query fetch does not
 * import the legacy page-loader / prefetch stack.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { stripMessageDiffSnapshots } from "./sanitize"

export type SessionMessageRecord<
  TInfo extends { id: string; parentID?: string | null } = { id: string; parentID?: string | null },
> = {
  info: TInfo
  parts?: unknown[]
}

export type SessionMessageQueryRecord = {
  info: Message
  parts?: Part[]
}

export const MAX_ASSISTANT_TAIL_PARENT_LOADS = 8

const inflight = new Map<string, Promise<unknown>>()

function singleFlight<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const pending = request().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  inflight.set(key, pending)
  return pending
}

type LoadSessionMessageInput<T> = {
  runtimeKey: string
  directory: string
  sessionID: string
  messageID: string
  request: () => Promise<T>
}

const messageKey = (input: Pick<LoadSessionMessageInput<unknown>, "runtimeKey" | "directory" | "sessionID" | "messageID">) =>
  `message\n${input.runtimeKey}\n${input.directory}\n${input.sessionID}\n${input.messageID}`

/** Shares exact parent-message requests across concurrent recoveries. */
export function loadSessionMessage<T>(input: LoadSessionMessageInput<T>): Promise<T> {
  return singleFlight(messageKey(input), input.request)
}

/** Flight key for exact `session.message` fills captured at request start. */
export function transcriptExactMessageRuntimeKey(transport: string, generation: number): string {
  return `${transport}\n${generation}`
}

/**
 * Load one Host message through `loadSessionMessage`, keyed by the captured
 * transport + generation. Callers must drop the result when live identity
 * no longer matches — this helper only dedupes the HTTP request.
 */
const lastFetchedPartsByMessage = new Map<string, SessionMessageQueryRecord["parts"]>()

/** Last exact `session.message` parts for a message, if a fill already ran. */
export function getLastFetchedSessionMessageParts(messageID: string): SessionMessageQueryRecord["parts"] | undefined {
  return lastFetchedPartsByMessage.get(messageID)
}

export async function fetchExactSessionMessageRecord(input: {
  transport: string
  generation: number
  directory: string
  sessionID: string
  messageID: string
  request: () => Promise<{ error?: unknown; data?: SessionMessageQueryRecord | undefined; parts?: SessionMessageQueryRecord["parts"] }>
}): Promise<SessionMessageQueryRecord> {
  return loadSessionMessage({
    runtimeKey: transcriptExactMessageRuntimeKey(input.transport, input.generation),
    directory: input.directory,
    sessionID: input.sessionID,
    messageID: input.messageID,
    request: async () => {
      const response = await input.request()
      if (response.error) throw new Error("session.message failed")
      const data = response.data
      const info = data?.info
      const parts = data?.parts ?? response.parts ?? []
      if (!info?.id) throw new Error("session.message failed: empty response")
      lastFetchedPartsByMessage.set(info.id, parts)
      return {
        info: stripMessageDiffSnapshots(info),
        parts,
      }
    },
  })
}

function isRole(record: SessionMessageRecord, role: string): boolean {
  const info = record.info as typeof record.info & { role?: unknown; clientRole?: unknown }
  return info.role === role || info.clientRole === role
}

/**
 * Collect parent user IDs referenced by assistant rows but absent from the page.
 * Recovery of those IDs is best-effort; a miss must not fail the Host page.
 */
export function findMissingAssistantParentUserIDs(records: SessionMessageRecord[]): string[] {
  const present = new Set(records.map((record) => record.info.id))
  const parentIDs: string[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!isRole(record, "assistant")) continue
    const parentID = record.info.parentID
    if (!parentID || present.has(parentID) || seen.has(parentID)) continue
    seen.add(parentID)
    parentIDs.push(parentID)
    if (parentIDs.length === MAX_ASSISTANT_TAIL_PARENT_LOADS) break
  }
  return parentIDs
}

export async function recoverAssistantTailBoundary<T extends SessionMessageRecord>(input: {
  records: T[]
  complete: boolean
  requestMessage: (messageID: string) => Promise<T>
}): Promise<{ records: T[]; boundaryFound: boolean; partial: boolean }> {
  if (input.complete) {
    const boundaryFound = input.records.some((record) => isRole(record, "user"))
    return { records: input.records, boundaryFound, partial: false }
  }

  const parentIDs = findMissingAssistantParentUserIDs(input.records)
  if (parentIDs.length === 0) {
    const boundaryFound = input.records.some((record) => isRole(record, "user"))
    return { records: input.records, boundaryFound, partial: !boundaryFound }
  }

  // One missing/failed parent must not fail the Host page. The page records
  // already landed; treat each exact fetch as best-effort.
  const parents = await Promise.all(parentIDs.map(async (messageID) => {
    try {
      return await input.requestMessage(messageID)
    } catch {
      return null
    }
  }))
  const byID = new Map<string, T>()
  for (const record of input.records) byID.set(record.info.id, record)
  for (const record of parents) {
    if (!record?.info?.id) continue
    byID.set(record.info.id, record)
  }
  const records = [...byID.values()].sort((a, b) => a.info.id.localeCompare(b.info.id))
  const boundaryFound = records.some((record) => isRole(record, "user"))
  return { records, boundaryFound, partial: !boundaryFound }
}
