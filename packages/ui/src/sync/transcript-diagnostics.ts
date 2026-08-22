import type { Message, Part } from "@opencode-ai/sdk/v2"

import type { TranscriptCommand, TranscriptData, TranscriptRequestState } from "./transcript-repository"

function isSlimPart(part: Part): boolean {
  return (part as { slim?: unknown }).slim === true
}

/** Optional paint/hydration facts. Compatible with TranscriptHydrationState. */
export type TranscriptDiagnosticsHydration = {
  readonly sessionID?: string
  readonly phase?: string
  readonly p0Satisfied?: boolean
}

/**
 * Client diagnostics hub. Each domain reports through a named feat
 * (`transcript` and `task` today; more feats can join the same export).
 *
 * User-message text is kept (bounded, credential-shaped values redacted)
 * so duplicate/optimistic rows can be located. Assistant/system bodies,
 * URLs, tokens, titles, prompts, agent names, and attachment payloads
 * stay out. SSE part.delta / unchanged connection batches are not recorded.
 */
export type ClientDiagnosticsFeat = "transcript" | "task"

export type TranscriptDiagnosticsKind =
  | "ensure-initial"
  | "http-page"
  | "durable-seed"
  | "sse-event"
  | "reset"
  | "materialize"
  | "refresh"
  | "purge"
  | "request-error"
  | "hydration"
  | "transcript-diff"

export type TaskDiagnosticsKind = "task-row" | "task-click"

export type ClientDiagnosticsKind = TranscriptDiagnosticsKind | TaskDiagnosticsKind

export type TaskClickOutcome =
  | "opened"
  | "queued"
  | "capability-off"
  | "missing-directory"
  | "navigate-rejected"

export type TaskClickSource = "row" | "queued-effect"

export type TranscriptDiagnosticsDiffTrigger =
  | "user-refresh"
  | "user-send"
  | "user-edit"
  | "user-delete"
  | "reconnect-compensation-reconcile"
  | "reconnect-compensation-reset"
  | "reconnect-compensation-ensure-tail"
  | "materialize"
  | "durable-seed"
  | "ensure-initial"
  | "destructive-reset"

export type TranscriptMessageSnapshot = {
  readonly id: string
  readonly partCount: number
  readonly slimCount: number
  readonly fullCount: number
  readonly optimistic: boolean
  /** True when `time.completed` is a positive number. Used only for optimisticLost. */
  readonly completed: boolean
  readonly role?: "user" | "assistant" | "system"
  /**
   * Bounded user-authored text only. Assistant/system bodies are never copied.
   */
  readonly text?: string
  /**
   * True when an assistant message lacks agent/mode identity or model
   * identity. Assistant-header display depends on these; recording the fact
   * (never the values) makes identity loss visible in exported diagnostics.
   */
  readonly identityMissing?: boolean
}

export type TranscriptCanonicalSnapshot = {
  readonly messageIDs: readonly string[]
  readonly messages: readonly TranscriptMessageSnapshot[]
  readonly boundaryKind: string
  readonly liveRevision: number
}

export type TranscriptPartCountSnapshot = {
  readonly partCount: number
  readonly slimCount: number
  readonly fullCount: number
  readonly optimistic: boolean
}

export type TranscriptDiff = {
  readonly addedMessageIDs: readonly string[]
  readonly removedMessageIDs: readonly string[]
  readonly partsChanged: readonly {
    readonly id: string
    readonly before: TranscriptPartCountSnapshot
    readonly after: TranscriptPartCountSnapshot
  }[]
  readonly downgraded: readonly string[]
  readonly optimisticLost: readonly string[]
  /** Assistant messages whose agent/model identity was present before and missing after. */
  readonly identityLost: readonly string[]
}

export type TranscriptDiagnosticsSource = "network" | "query-cache" | "durable-cache" | "sse"

export type TranscriptDiagnosticsEvent = {
  readonly at: number
  readonly feat: ClientDiagnosticsFeat
  readonly kind: ClientDiagnosticsKind
  readonly sessionID: string
  readonly directory?: string
  readonly transport?: string
  readonly generation?: number
  readonly source?: TranscriptDiagnosticsSource
  readonly durationMs?: number
  readonly requestStatus?: TranscriptRequestState["status"]
  readonly hydrationPhase?: string
  readonly p0Satisfied?: boolean
  readonly httpStatus?: number
  readonly messageCount?: number
  readonly lastMessageIDs?: readonly string[]
  readonly boundaryKind?: TranscriptData["boundary"]["kind"]
  readonly slimPartCount?: number
  readonly fullPartCount?: number
  /** Assistant messages currently held without agent/model identity (header display facts only). */
  readonly identityMissingCount?: number
  readonly command?: TranscriptCommand["type"]
  readonly purpose?: string
  readonly sseType?: string
  readonly error?: string
  readonly trigger?: TranscriptDiagnosticsDiffTrigger
  readonly before?: TranscriptCanonicalSnapshot
  readonly after?: TranscriptCanonicalSnapshot
  readonly diff?: TranscriptDiff
  readonly partID?: string
  readonly messageID?: string
  readonly childSessionID?: string
  readonly childSessionPresent?: boolean
  readonly toolStatus?: string
  readonly finalized?: boolean
  readonly backgroundRunning?: boolean
  readonly effectiveActive?: boolean
  readonly suppressLoading?: boolean
  readonly delegating?: boolean
  readonly childStatus?: string
  readonly parentStatus?: string
  readonly idleConfirmed?: boolean
  readonly clickOutcome?: TaskClickOutcome
  readonly clickSource?: TaskClickSource
  readonly surfaceKind?: string
  readonly navigateCapability?: boolean
  readonly directoryPresent?: boolean
  readonly taskStartedAt?: number
  readonly statusObservedAt?: number
  readonly statusSnapshotAt?: number
}

export type TranscriptDiagnosticsSink = {
  append: (event: TranscriptDiagnosticsEvent) => void | Promise<void>
  read: () => Promise<readonly TranscriptDiagnosticsEvent[]>
  clear: () => Promise<void>
}

export const TRANSCRIPT_DIAGNOSTICS_LIMIT = 500
export const TRANSCRIPT_DIAGNOSTICS_TAIL_IDS = 4
export const TRANSCRIPT_DIAGNOSTICS_USER_TEXT_LIMIT = 400

const SENSITIVE_ERROR = /bearer|token|authorization|password|secret|cookie/i
const DIAGNOSTICS_SSE_NOISE_TYPES = new Set(["message.part.delta"])

export function isPrereleaseClientVersion(version: string | null | undefined): boolean {
  return typeof version === "string" && version.includes("-")
}

export const TRANSCRIPT_DIAGNOSTICS_PREFERENCE_KEY = "openchamber.client-diagnostics.enabled"

export function parseTranscriptDiagnosticsPreference(raw: string | null | undefined): boolean | null {
  if (raw === "true") return true
  if (raw === "false") return false
  return null
}

export function resolveTranscriptDiagnosticsEnabled(input: {
  version?: string | null
  preference?: boolean | null
}): boolean {
  if (input.preference === true) return true
  if (input.preference === false) return false
  return isPrereleaseClientVersion(input.version)
}

export function diagnosticsExportFileName(now = Date.now()): string {
  return `openchamber-diagnostics-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`
}

export function diagnosticsExportEventCount(content: string): number {
  try {
    const parsed = JSON.parse(content) as { eventCount?: unknown }
    return typeof parsed.eventCount === "number" && Number.isFinite(parsed.eventCount)
      ? parsed.eventCount
      : 0
  } catch {
    return 0
  }
}

export function diagnosticsHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === "number" && Number.isFinite(status) && status >= 100 && status <= 599) {
      return status
    }
  }
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const match = text.match(/\((\d{3})\)/)
  if (!match) return undefined
  const status = Number(match[1])
  return status >= 100 && status <= 599 ? status : undefined
}

export function sanitizeDiagnosticsError(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = value instanceof Error ? value.message : String(value)
  const trimmed = text.trim().slice(0, 240)
  if (!trimmed) return undefined
  if (SENSITIVE_ERROR.test(trimmed)) return "redacted-error"
  return trimmed
}

export function summarizeTranscriptParts(partsByMessageID: TranscriptData["partsByMessageID"]): {
  slimPartCount: number
  fullPartCount: number
} {
  let slimPartCount = 0
  let fullPartCount = 0
  for (const parts of Object.values(partsByMessageID)) {
    if (!parts) continue
    for (const part of parts) {
      if (isSlimPart(part as Part)) slimPartCount += 1
      else fullPartCount += 1
    }
  }
  return { slimPartCount, fullPartCount }
}

export function lastTranscriptMessageIDs(
  messageOrder: readonly string[],
  limit = TRANSCRIPT_DIAGNOSTICS_TAIL_IDS,
): readonly string[] {
  if (messageOrder.length <= limit) return messageOrder.slice()
  return messageOrder.slice(messageOrder.length - limit)
}

/** Count assistant messages currently held without agent/model identity. */
export function countIdentityMissingMessages(transcript: TranscriptData): number {
  let missing = 0
  for (const id of transcript.messageOrder) {
    if (snapshotMessageIdentityMissing(transcript.messagesByID[id]) === true) {
      missing += 1
    }
  }
  return missing
}

export function snapshotTranscriptDiagnostics(input: {
  kind: TranscriptDiagnosticsKind
  sessionID: string
  directory?: string
  transport?: string
  generation?: number
  source?: TranscriptDiagnosticsSource
  durationMs?: number
  transcript?: TranscriptData
  request?: TranscriptRequestState
  hydration?: TranscriptDiagnosticsHydration
  command?: TranscriptCommand["type"]
  purpose?: string
  sseType?: string
  error?: unknown
  now?: () => number
}): TranscriptDiagnosticsEvent {
  const parts = input.transcript ? summarizeTranscriptParts(input.transcript.partsByMessageID) : undefined
  return {
    at: (input.now ?? Date.now)(),
    feat: "transcript",
    kind: input.kind,
    sessionID: input.sessionID,
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.request ? { requestStatus: input.request.status } : {}),
    ...(input.hydration
      ? { hydrationPhase: input.hydration.phase, p0Satisfied: input.hydration.p0Satisfied }
      : {}),
    ...(input.transcript
      ? {
        messageCount: input.transcript.messageOrder.length,
        lastMessageIDs: lastTranscriptMessageIDs(input.transcript.messageOrder),
        boundaryKind: input.transcript.boundary.kind,
        slimPartCount: parts?.slimPartCount,
        fullPartCount: parts?.fullPartCount,
        identityMissingCount: countIdentityMissingMessages(input.transcript),
      }
      : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.sseType ? { sseType: input.sseType } : {}),
    ...(sanitizeDiagnosticsError(input.error ?? input.request?.error)
      ? { error: sanitizeDiagnosticsError(input.error ?? input.request?.error) }
      : {}),
    ...(diagnosticsHttpStatus(input.error) !== undefined
      ? { httpStatus: diagnosticsHttpStatus(input.error) }
      : {}),
  }
}

export function createMemoryTranscriptDiagnosticsSink(
  options: { limit?: number } = {},
): TranscriptDiagnosticsSink {
  const limit = options.limit ?? TRANSCRIPT_DIAGNOSTICS_LIMIT
  const events: TranscriptDiagnosticsEvent[] = []
  return {
    append(event) {
      events.push(event)
      if (events.length > limit) events.splice(0, events.length - limit)
    },
    async read() {
      return events.slice()
    },
    async clear() {
      events.length = 0
    },
  }
}

export type TranscriptDiagnosticsRecorder = {
  isEnabled: () => boolean
  record: (event: TranscriptDiagnosticsEvent) => void
  exportReport: () => Promise<string>
  clear: () => Promise<void>
}

export function createTranscriptDiagnosticsRecorder(input: {
  sink: TranscriptDiagnosticsSink
  isEnabled: () => boolean
}): TranscriptDiagnosticsRecorder {
  return {
    isEnabled: input.isEnabled,
    record(event) {
      if (!input.isEnabled()) return
      void Promise.resolve(input.sink.append(event)).catch(() => undefined)
    },
    async exportReport() {
      const events = await input.sink.read()
      const feats = [...new Set(events.map((event) => event.feat))]
      return JSON.stringify({
        schema: "openchamber.client-diagnostics.v1",
        exportedAt: Date.now(),
        eventCount: events.length,
        feats,
        events,
      }, null, 2)
    },
    clear: () => input.sink.clear(),
  }
}

export function isDiagnosticsSseNoiseType(type: string | undefined): boolean {
  return typeof type === "string" && DIAGNOSTICS_SSE_NOISE_TYPES.has(type)
}

export function diagnosticsKindForCommand(command: TranscriptCommand): TranscriptDiagnosticsKind | null {
  switch (command.type) {
    case "http-page":
      return "http-page"
    case "sse-event":
      return isDiagnosticsSseNoiseType(command.event.type) ? null : "sse-event"
    case "sse-event-batch":
      return command.events.every((event) => isDiagnosticsSseNoiseType(event.type)) ? null : "sse-event"
    case "reset":
      return "reset"
    case "materialize-snapshots":
      return "durable-seed"
    case "remove-message":
      return "purge"
    default:
      return null
  }
}

export function commandPurpose(command: TranscriptCommand): string | undefined {
  if (command.type === "http-page") return command.purpose
  return undefined
}

export function commandSseType(command: TranscriptCommand): string | undefined {
  if (command.type === "sse-event") return command.event.type
  if (command.type === "sse-event-batch") return "sse-event-batch"
  return undefined
}

export function diagnosticsSourceForCommand(command: TranscriptCommand): TranscriptDiagnosticsSource | undefined {
  switch (command.type) {
    case "http-page":
      return "network"
    case "sse-event":
    case "sse-event-batch":
      return "sse"
    case "materialize-snapshots":
      return "durable-cache"
    default:
      return undefined
  }
}

/** Test helper: count messages without exposing Message bodies. */
export function countSettledMessages(messagesByID: Readonly<Record<string, Message>>): number {
  return Object.keys(messagesByID).length
}

function isOptimisticPart(part: Part): boolean {
  return (part as { __openchamberOptimistic?: unknown }).__openchamberOptimistic === true
}

export function extractDiagnosticsUserText(parts: readonly Part[]): string | undefined {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type !== "text") continue
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text.trim() : ""
    if (text) chunks.push(text)
  }
  const joined = chunks.join("\n").trim()
  if (!joined) return undefined
  if (SENSITIVE_ERROR.test(joined)) return "redacted-text"
  if (joined.length <= TRANSCRIPT_DIAGNOSTICS_USER_TEXT_LIMIT) return joined
  return `${joined.slice(0, TRANSCRIPT_DIAGNOSTICS_USER_TEXT_LIMIT)}…`
}

function snapshotMessageRole(info: Message | undefined): TranscriptMessageSnapshot["role"] | undefined {
  if (!info) return undefined
  const raw = (info as { clientRole?: unknown; role?: unknown }).clientRole ?? info.role
  if (raw === "user" || raw === "assistant" || raw === "system") return raw
  return undefined
}

function snapshotMessageCompleted(info: Message | undefined): boolean {
  const completed = (info as { time?: { completed?: unknown } } | undefined)?.time?.completed
  return typeof completed === "number" && completed > 0
}

const nonEmptyInfoString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0

/** Assistant-header identity facts only — never records the values themselves. */
function snapshotMessageIdentityMissing(info: Message | undefined): boolean | undefined {
  if (!info) return undefined
  if (snapshotMessageRole(info) !== "assistant") return undefined
  const record = info as Record<string, unknown>
  const agentMissing = !nonEmptyInfoString(record.mode) && !nonEmptyInfoString(record.agent)
  const modelMissing = !nonEmptyInfoString(record.modelID) || !nonEmptyInfoString(record.providerID)
  return agentMissing || modelMissing
}

function toPartCountSnapshot(message: TranscriptMessageSnapshot): TranscriptPartCountSnapshot {
  return {
    partCount: message.partCount,
    slimCount: message.slimCount,
    fullCount: message.fullCount,
    optimistic: message.optimistic,
  }
}

/**
 * Read-only identity/count snapshot. User text is bounded; assistant bodies
 * and attachment payloads are never copied.
 */
export function captureTranscriptCanonicalSnapshot(
  transcript: TranscriptData,
): TranscriptCanonicalSnapshot {
  const messages: TranscriptMessageSnapshot[] = transcript.messageOrder.map((id) => {
    const parts = transcript.partsByMessageID[id] ?? []
    let slimCount = 0
    let fullCount = 0
    let optimistic = false
    for (const part of parts) {
      if (isSlimPart(part)) slimCount += 1
      else fullCount += 1
      if (isOptimisticPart(part)) optimistic = true
    }
    const info = transcript.messagesByID[id]
    const role = snapshotMessageRole(info)
    const identityMissing = snapshotMessageIdentityMissing(info)
    const text = role === "user" ? extractDiagnosticsUserText(parts) : undefined
    return {
      id,
      partCount: parts.length,
      slimCount,
      fullCount,
      optimistic,
      completed: snapshotMessageCompleted(info),
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
      ...(identityMissing !== undefined ? { identityMissing } : {}),
    }
  })
  return {
    messageIDs: transcript.messageOrder.slice(),
    messages,
    boundaryKind: transcript.boundary.kind,
    liveRevision: transcript.liveRevision,
  }
}

export function diffTranscriptCanonicalSnapshots(
  before: TranscriptCanonicalSnapshot,
  after: TranscriptCanonicalSnapshot,
): TranscriptDiff {
  const beforeByID = new Map(before.messages.map((message) => [message.id, message]))
  const afterByID = new Map(after.messages.map((message) => [message.id, message]))
  const beforeIDs = new Set(before.messageIDs)
  const afterIDs = new Set(after.messageIDs)

  const addedMessageIDs = after.messageIDs.filter((id) => !beforeIDs.has(id))
  const removedMessageIDs = before.messageIDs.filter((id) => !afterIDs.has(id))
  const partsChanged: TranscriptDiff["partsChanged"][number][] = []
  const downgraded: string[] = []
  const optimisticLost: string[] = []
  const identityLost: string[] = []

  for (const id of before.messageIDs) {
    const previous = beforeByID.get(id)
    if (!previous) continue
    const next = afterByID.get(id)
    if (!next) {
      if (previous.optimistic) optimisticLost.push(id)
      continue
    }
    if (
      previous.partCount !== next.partCount
      || previous.slimCount !== next.slimCount
      || previous.fullCount !== next.fullCount
      || previous.optimistic !== next.optimistic
    ) {
      partsChanged.push({
        id,
        before: toPartCountSnapshot(previous),
        after: toPartCountSnapshot(next),
      })
    }
    if (previous.fullCount > 0 && next.fullCount === 0 && next.slimCount > 0) {
      downgraded.push(id)
    }
    if (previous.optimistic && !next.optimistic && !next.completed) {
      optimisticLost.push(id)
    }
    if (previous.identityMissing !== true && next.identityMissing === true) {
      identityLost.push(id)
    }
  }

  return { addedMessageIDs, removedMessageIDs, partsChanged, downgraded, optimisticLost, identityLost }
}

export function snapshotTranscriptDiff(input: {
  trigger: TranscriptDiagnosticsDiffTrigger
  sessionID: string
  directory?: string
  transport?: string
  generation?: number
  purpose?: string
  before: TranscriptCanonicalSnapshot
  after: TranscriptCanonicalSnapshot
  now?: () => number
}): TranscriptDiagnosticsEvent {
  return {
    at: (input.now ?? Date.now)(),
    feat: "transcript",
    kind: "transcript-diff",
    sessionID: input.sessionID,
    trigger: input.trigger,
    before: input.before,
    after: input.after,
    diff: diffTranscriptCanonicalSnapshots(input.before, input.after),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
  }
}

export type TaskDiagnosticsFacts = {
  readonly sessionID: string
  readonly partID?: string
  readonly messageID?: string
  readonly directory?: string
  readonly directoryPresent: boolean
  readonly childSessionPresent: boolean
  readonly childSessionID?: string
  readonly toolStatus?: string
  readonly finalized: boolean
  readonly backgroundRunning: boolean
  readonly effectiveActive: boolean
  readonly suppressLoading: boolean
  readonly delegating: boolean
  readonly childStatus: string
  readonly parentStatus: string
  readonly idleConfirmed: boolean
  readonly navigateCapability: boolean
  readonly surfaceKind?: string
  readonly taskStartedAt?: number
  readonly statusObservedAt?: number
  readonly statusSnapshotAt?: number
}

export function diagnosticsSessionStatusType(status: { type?: unknown } | null | undefined): string {
  if (!status || typeof status.type !== "string") return "missing"
  const trimmed = status.type.trim()
  return trimmed.length > 0 ? trimmed : "missing"
}

export function resolveTaskClickOutcome(input: {
  opened: boolean
  navigateCapability: boolean
  childSessionPresent: boolean
  directoryPresent: boolean
}): TaskClickOutcome {
  if (input.opened) return "opened"
  if (!input.navigateCapability) return "capability-off"
  if (!input.directoryPresent) return "missing-directory"
  if (!input.childSessionPresent) return "queued"
  return "navigate-rejected"
}

function optionalIdentity(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function taskDiagnosticsFields(facts: TaskDiagnosticsFacts): Partial<TranscriptDiagnosticsEvent> {
  const partID = optionalIdentity(facts.partID)
  const messageID = optionalIdentity(facts.messageID)
  const directory = optionalIdentity(facts.directory)
  const childSessionID = optionalIdentity(facts.childSessionID)
  const toolStatus = optionalIdentity(facts.toolStatus)
  const surfaceKind = optionalIdentity(facts.surfaceKind)
  return {
    directoryPresent: facts.directoryPresent,
    childSessionPresent: facts.childSessionPresent,
    finalized: facts.finalized,
    backgroundRunning: facts.backgroundRunning,
    effectiveActive: facts.effectiveActive,
    suppressLoading: facts.suppressLoading,
    delegating: facts.delegating,
    childStatus: facts.childStatus,
    parentStatus: facts.parentStatus,
    idleConfirmed: facts.idleConfirmed,
    navigateCapability: facts.navigateCapability,
    ...(partID ? { partID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(childSessionID ? { childSessionID } : {}),
    ...(toolStatus ? { toolStatus } : {}),
    ...(surfaceKind ? { surfaceKind } : {}),
    ...(facts.taskStartedAt !== undefined ? { taskStartedAt: facts.taskStartedAt } : {}),
    ...(facts.statusObservedAt !== undefined ? { statusObservedAt: facts.statusObservedAt } : {}),
    ...(facts.statusSnapshotAt !== undefined ? { statusSnapshotAt: facts.statusSnapshotAt } : {}),
  }
}

export function taskRowDiagnosticsSignature(facts: TaskDiagnosticsFacts): string {
  return [
    facts.sessionID,
    optionalIdentity(facts.partID) ?? "",
    facts.childSessionPresent ? "1" : "0",
    optionalIdentity(facts.childSessionID) ?? "",
    optionalIdentity(facts.toolStatus) ?? "",
    facts.finalized ? "1" : "0",
    facts.backgroundRunning ? "1" : "0",
    facts.effectiveActive ? "1" : "0",
    facts.suppressLoading ? "1" : "0",
    facts.delegating ? "1" : "0",
    facts.childStatus,
    facts.parentStatus,
    facts.idleConfirmed ? "1" : "0",
    facts.navigateCapability ? "1" : "0",
    facts.directoryPresent ? "1" : "0",
    optionalIdentity(facts.surfaceKind) ?? "",
    String(facts.taskStartedAt ?? ""),
    String(facts.statusObservedAt ?? ""),
    String(facts.statusSnapshotAt ?? ""),
  ].join("\u0000")
}

export function snapshotTaskRowDiagnostics(input: TaskDiagnosticsFacts & {
  now?: () => number
}): TranscriptDiagnosticsEvent {
  return {
    at: (input.now ?? Date.now)(),
    feat: "task",
    kind: "task-row",
    sessionID: input.sessionID,
    ...taskDiagnosticsFields(input),
  }
}

export function snapshotTaskClickDiagnostics(input: TaskDiagnosticsFacts & {
  opened: boolean
  clickSource: TaskClickSource
  now?: () => number
}): TranscriptDiagnosticsEvent {
  return {
    at: (input.now ?? Date.now)(),
    feat: "task",
    kind: "task-click",
    sessionID: input.sessionID,
    clickSource: input.clickSource,
    clickOutcome: resolveTaskClickOutcome(input),
    ...taskDiagnosticsFields(input),
  }
}
