/**
 * Self-heal for a transcript body that stops advancing while its session is
 * still reported as working.
 *
 * The message body and the session status line are independent subscriptions
 * over the same session. Any defect that silences the body — a subscription
 * that never re-arms, an event that never reaches the Query cache, a scope key
 * that stops resolving — leaves the status line animating above a frozen
 * transcript. To the user that is indistinguishable from "the message I just
 * sent disappeared", and it is unrecoverable without a manual refresh.
 *
 * Rather than chase each such defect one at a time, treat a provably frozen
 * tail under an active status as a repairable state and refetch the
 * authoritative tail.
 *
 * Firing is deliberately hard: the session must be working, the rendered tail
 * must be byte-identical for `thresholdMs`, and no local stream may be in
 * progress. A healthy stream moves the fingerprint on every delta, so the only
 * states that reach the threshold are ones the body cannot repair on its own.
 */

export const TRANSCRIPT_STALL_THRESHOLD_MS = 20_000
export const TRANSCRIPT_STALL_COOLDOWN_MS = 60_000
export const TRANSCRIPT_STALL_MAX_ATTEMPTS = 3
export const TRANSCRIPT_STALL_POLL_MS = 2_000

type FingerprintPart = {
  id?: string
  type?: string
  text?: string
  state?: { status?: string; output?: string }
}

type FingerprintRecord = {
  info: { id: string }
  parts: readonly FingerprintPart[]
}

/**
 * Payload size of a part. Text and tool output grow in place under a stable
 * part id, so length is what separates a live stream from a frozen one.
 */
const measurePart = (part: FingerprintPart | undefined): number => {
  if (!part) return 0
  const text = typeof part.text === "string" ? part.text.length : 0
  const output = typeof part.state?.output === "string" ? part.state.output.length : 0
  return text + output
}

/**
 * Compact signature of the rendered tail. Covers row count, trailing message
 * identity, part count, trailing part identity/status, and total payload size
 * of the open turn — every axis along which a healthy turn advances.
 */
export const buildTranscriptTailFingerprint = (records: readonly FingerprintRecord[]): string => {
  if (records.length === 0) return "0"
  const last = records[records.length - 1]
  if (!last) return "0"
  const parts = last.parts ?? []
  const lastPart = parts[parts.length - 1]
  let payload = 0
  for (const part of parts) payload += measurePart(part)
  return [
    records.length,
    last.info.id,
    parts.length,
    lastPart?.id ?? "",
    lastPart?.state?.status ?? "",
    payload,
  ].join(":")
}

export type TranscriptStallState = {
  readonly sessionKey: string | null
  readonly fingerprint: string | null
  /** When the tail last moved. Stall duration is measured from here. */
  readonly lastMovementAt: number | null
  readonly lastRefreshAt: number | null
  readonly attempts: number
}

export const INITIAL_TRANSCRIPT_STALL_STATE: TranscriptStallState = {
  sessionKey: null,
  fingerprint: null,
  lastMovementAt: null,
  lastRefreshAt: null,
  attempts: 0,
}

export type TranscriptStallInput = {
  /** Directory + session identity. A change resets all stall history. */
  sessionKey: string | null
  working: boolean
  /** A local stream for this session is mid-flight. */
  streaming: boolean
  fingerprint: string
  now: number
  thresholdMs: number
  cooldownMs: number
  maxAttempts: number
}

export type TranscriptStallResult = {
  state: TranscriptStallState
  shouldRefresh: boolean
  stalledForMs: number
}

export const advanceTranscriptStallState = (
  state: TranscriptStallState,
  input: TranscriptStallInput,
): TranscriptStallResult => {
  const { sessionKey, working, streaming, fingerprint, now } = input

  if (!sessionKey) {
    return { state: INITIAL_TRANSCRIPT_STALL_STATE, shouldRefresh: false, stalledForMs: 0 }
  }

  // One session's stall history must never carry into another.
  if (state.sessionKey !== sessionKey) {
    return {
      state: { sessionKey, fingerprint, lastMovementAt: now, lastRefreshAt: null, attempts: 0 },
      shouldRefresh: false,
      stalledForMs: 0,
    }
  }

  // Any movement in the rendered tail proves the body is live. Attempts reset
  // so a later, unrelated stall gets a full budget.
  if (state.fingerprint !== fingerprint) {
    return {
      state: { ...state, fingerprint, lastMovementAt: now, attempts: 0 },
      shouldRefresh: false,
      stalledForMs: 0,
    }
  }

  // An idle session may sit still forever, and a live local stream means this
  // turn is already reaching the body. Neither accrues stall time.
  if (!working || streaming) {
    return { state: { ...state, lastMovementAt: now }, shouldRefresh: false, stalledForMs: 0 }
  }

  const lastMovementAt = state.lastMovementAt ?? now
  const stalledForMs = now - lastMovementAt
  const cooledDown = state.lastRefreshAt === null || now - state.lastRefreshAt >= input.cooldownMs
  const shouldRefresh = stalledForMs >= input.thresholdMs
    && cooledDown
    && state.attempts < input.maxAttempts

  return {
    state: {
      ...state,
      lastMovementAt,
      lastRefreshAt: shouldRefresh ? now : state.lastRefreshAt,
      attempts: shouldRefresh ? state.attempts + 1 : state.attempts,
    },
    shouldRefresh,
    stalledForMs,
  }
}

/**
 * Reported unconditionally, not through the localStorage-gated sync debug
 * channel: this fires at most `maxAttempts` times per stall and is the only
 * evidence available when the fault shows up on someone else's device.
 */
export const reportTranscriptStall = (detail: {
  sessionId: string
  directory: string
  stalledForMs: number
  attempt: number
  fingerprint: string
}): void => {
  console.warn("[transcript] tail frozen while session is working — refetching authority", detail)
}
