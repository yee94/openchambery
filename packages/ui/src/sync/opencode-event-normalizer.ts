/**
 * Pure OpenCode event envelope normalizer.
 *
 * Runs at transport ingress, before directory resolution and coalescing.
 * Accepts legacy `{ type, properties }`, current `{ type, data, location, durable }`,
 * and global envelopes that wrap a payload. Versioned types (`session.status.1`)
 * are stripped to their base name. Current durable `sync` replicas are filtered
 * so the same logical event is not consumed twice.
 *
 * Does not invent legacy Message/Part events from current text/tool streams —
 * those remain domain-activity / prefetch-dirty hints handled by sync-context.
 */

export type NormalizedOpenCodeEvent = {
  id?: string
  type: string
  properties: Record<string, unknown>
  /** Directory hint from current `location` or legacy properties. */
  locationDirectory?: string
  /** Admission confirmation hint for `session.next.prompt.admitted`. */
  admissionHint?: {
    sessionID: string
    messageID?: string
  }
  /** Domain-activity / prefetch-dirty hint for current step/text/reasoning/tool events. */
  domainActivityHint?: {
    sessionID: string
    kind: "activity" | "terminal"
  }
}

export type NormalizeOpenCodeEventResult =
  | { action: "emit"; event: NormalizedOpenCodeEvent }
  | { action: "drop"; reason: "sync-duplicate" | "invalid" }

const VERSIONED_TYPE = /^(.*)\.(\d+)$/

const CURRENT_ACTIVITY_PREFIXES = [
  "session.next.step.",
  "session.next.text.",
  "session.next.reasoning.",
  "session.next.tool.",
  "session.next.shell.",
  "session.next.compaction.",
] as const

const CURRENT_TERMINAL_TYPES = new Set([
  "session.next.step.ended",
  "session.next.step.failed",
])

function stripVersionSuffix(type: string): string {
  const match = VERSIONED_TYPE.exec(type)
  return match?.[1] ?? type
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readSessionID(record: Record<string, unknown>): string | undefined {
  const direct = record.sessionID
  if (typeof direct === "string" && direct.length > 0) return direct
  const camel = record.sessionId
  if (typeof camel === "string" && camel.length > 0) return camel
  return undefined
}

function isSyncDurableReplica(record: Record<string, unknown>): boolean {
  const durable = asRecord(record.durable)
  if (!durable) return false
  const kind = durable.kind ?? durable.type ?? durable.source
  if (typeof kind === "string" && kind.toLowerCase() === "sync") return true
  if (durable.sync === true) return true
  // OpenCode current durable envelope may tag replicas with aggregate/source "sync".
  const aggregateID = durable.aggregateID
  if (typeof aggregateID === "string" && aggregateID.startsWith("sync:")) return true
  return false
}

function extractLocationDirectory(record: Record<string, unknown>): string | undefined {
  const location = asRecord(record.location)
  if (location) {
    const path = location.path ?? location.directory
    if (typeof path === "string" && path.length > 0) return path
  }
  const directory = record.directory
  if (typeof directory === "string" && directory.length > 0) return directory
  return undefined
}

function unwrapGlobalEnvelope(raw: unknown): unknown {
  const record = asRecord(raw)
  if (!record) return raw
  // GlobalEvent: { directory, payload }
  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>
    if (typeof payload.type === "string") {
      return {
        ...payload,
        // Preserve outer directory as a location hint when payload lacks one.
        ...(typeof record.directory === "string" && !extractLocationDirectory(payload)
          ? { directory: record.directory }
          : {}),
      }
    }
  }
  return raw
}

function toLegacyProperties(
  type: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  // Current session.status uses data: { sessionID, status } — already legacy-shaped.
  if (type === "session.status") {
    const sessionID = readSessionID(body)
    const status = body.status
    if (sessionID && status && typeof status === "object") {
      return { sessionID, status }
    }
  }
  return body
}

function buildHints(
  type: string,
  properties: Record<string, unknown>,
): Pick<NormalizedOpenCodeEvent, "admissionHint" | "domainActivityHint"> {
  const sessionID = readSessionID(properties)
  if (!sessionID) return {}

  if (type === "session.next.prompt.admitted") {
    const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined
    return {
      admissionHint: { sessionID, messageID },
      domainActivityHint: { sessionID, kind: "activity" },
    }
  }

  if (CURRENT_TERMINAL_TYPES.has(type)) {
    return { domainActivityHint: { sessionID, kind: "terminal" } }
  }

  if (CURRENT_ACTIVITY_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    return { domainActivityHint: { sessionID, kind: "activity" } }
  }

  // Other session.next.* (agent/model switched, prompted, etc.) still mark activity.
  if (type.startsWith("session.next.")) {
    return { domainActivityHint: { sessionID, kind: "activity" } }
  }

  return {}
}

/**
 * Normalize one transport frame into the legacy Event reducer contract, or drop
 * it when it is a durable sync replica / invalid.
 */
export function normalizeOpenCodeEvent(raw: unknown): NormalizeOpenCodeEventResult {
  const unwrapped = unwrapGlobalEnvelope(raw)
  const record = asRecord(unwrapped)
  if (!record) return { action: "drop", reason: "invalid" }

  const rawType = record.type
  if (typeof rawType !== "string" || rawType.length === 0) {
    return { action: "drop", reason: "invalid" }
  }

  if (isSyncDurableReplica(record)) {
    return { action: "drop", reason: "sync-duplicate" }
  }

  const type = stripVersionSuffix(rawType)

  // Prefer current `data`, fall back to legacy `properties`.
  const dataBody = asRecord(record.data)
  const propertiesBody = asRecord(record.properties)
  const body = dataBody ?? propertiesBody
  if (!body) {
    // Some openchamber synthetic events only have type+properties as empty-ish;
    // still emit with empty properties for openchamber:* pass-through.
    if (type.startsWith("openchamber:")) {
      return {
        action: "emit",
        event: {
          id: typeof record.id === "string" ? record.id : undefined,
          type,
          properties: propertiesBody ?? {},
          locationDirectory: extractLocationDirectory(record),
        },
      }
    }
    return { action: "drop", reason: "invalid" }
  }

  const properties = toLegacyProperties(type, body)
  const locationDirectory =
    extractLocationDirectory(record)
    ?? extractLocationDirectory(body)
    ?? (() => {
      const info = asRecord(properties.info)
      return typeof info?.directory === "string" ? info.directory : undefined
    })()

  const hints = buildHints(type, properties)

  return {
    action: "emit",
    event: {
      id: typeof record.id === "string" ? record.id : undefined,
      type,
      properties,
      locationDirectory,
      ...hints,
    },
  }
}

/** Convert a normalized event into the legacy `{ type, properties, id? }` Event shape. */
export function toLegacyEventShape(event: NormalizedOpenCodeEvent): {
  id?: string
  type: string
  properties: Record<string, unknown>
} {
  return {
    ...(event.id ? { id: event.id } : {}),
    type: event.type,
    properties: event.properties,
  }
}
