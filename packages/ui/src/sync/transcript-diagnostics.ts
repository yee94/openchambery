import type { Message, Part } from "@opencode-ai/sdk/v2"

import type { TranscriptCommand, TranscriptData, TranscriptRequestState } from "./transcript-repository"

function isSlimPart(part: Part): boolean {
  return (part as { slim?: unknown }).slim === true
}

/** Optional paint/hydration facts. This branch has no hydration repository API. */
export type TranscriptDiagnosticsHydration = {
  readonly sessionID?: string
  readonly phase?: string
  readonly p0Satisfied?: boolean
}

/**
 * Client diagnostics hub. Each domain reports through a named feat
 * (`transcript` today; more feats can join the same export).
 *
 * Events never carry message bodies, part text, URLs, tokens, or attachment
 * payloads — only identities and lifecycle facts.
 */
export type ClientDiagnosticsFeat = "transcript"

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

export type TranscriptDiagnosticsSource = "network" | "query-cache" | "durable-cache" | "sse"

export type TranscriptDiagnosticsEvent = {
  readonly at: number
  readonly feat: ClientDiagnosticsFeat
  readonly kind: TranscriptDiagnosticsKind
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
  readonly command?: TranscriptCommand["type"]
  readonly purpose?: string
  readonly sseType?: string
  readonly error?: string
}

export type TranscriptDiagnosticsSink = {
  append: (event: TranscriptDiagnosticsEvent) => void | Promise<void>
  read: () => Promise<readonly TranscriptDiagnosticsEvent[]>
  clear: () => Promise<void>
}

export const TRANSCRIPT_DIAGNOSTICS_LIMIT = 500
export const TRANSCRIPT_DIAGNOSTICS_TAIL_IDS = 4

const SENSITIVE_ERROR = /bearer|token|authorization|password|secret|cookie/i

export function isPrereleaseClientVersion(version: string | null | undefined): boolean {
  return typeof version === "string" && version.includes("-")
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

export function diagnosticsKindForCommand(command: TranscriptCommand): TranscriptDiagnosticsKind | null {
  switch (command.type) {
    case "http-page":
      return "http-page"
    case "sse-event":
      return command.event.type === "message.part.delta" ? null : "sse-event"
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
  return undefined
}

export function diagnosticsSourceForCommand(command: TranscriptCommand): TranscriptDiagnosticsSource | undefined {
  switch (command.type) {
    case "http-page":
      return "network"
    case "sse-event":
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
