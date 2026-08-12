/**
 * Event Pipeline — transport connection, event coalescing, and batched flush.
 *
 * This module must not make state-dependent decisions about event validity.
 * For example, deciding whether a delta is already represented by a full part
 * snapshot belongs in the reducer, which has access to the current state.
 *
 * Plain closure API:
 *   const { cleanup } = createEventPipeline({ sdk, onEvent })
 *
 * No class, no start/stop lifecycle. One pipeline per mount.
 * Abort controller created once at init, cleaned up via returned cleanup fn.
 */

import type { Event, OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { type RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { openRuntimeWebSocket } from "@/lib/relay/runtime-socket"
import { getRuntimeGeneration } from "@/lib/runtime-switch"
import {
  normalizeOpenCodeEvent,
  toLegacyEventShape,
  type NormalizedOpenCodeEvent,
} from "./opencode-event-normalizer"
import { syncDebug } from "./debug"

const FLUSH_FRAME_MS = 33
const BACKPRESSURE_FLUSH_FRAME_MS = 200
const BACKPRESSURE_MODE_MS = 10_000
const STREAM_YIELD_MS = 8
const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const WS_FALLBACK_WINDOW_MS = 60_000
// Consecutive rejections of the same eventId before the pipeline steps over it
// rather than resuming into the same failure again.
const UNUSABLE_FRAME_SKIP_AFTER = 2
const DEFAULT_WS_READY_TIMEOUT_MS = 2_000
// Retry pacing. Visible+online tabs probe quickly so the user sees connection
// recovery in under a second of real outage; hidden/offline tabs back off
// further so a backgrounded PWA on a flaky link doesn't burn battery probing
// a dead network every few seconds. The browser would throttle hidden-tab
// timers anyway, but this keeps the intent explicit and shrinks server load
// from idle tabs.
const RETRY_BACKOFF_BASE_MS = 250
const RETRY_BACKOFF_CAP_VISIBLE_MS = 5_000
const RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000
const RETRY_BACKOFF_MAX_EXPONENT = 8
/**
 * Recovery context captured on disconnect / visibility hidden / system resume
 * / online-driven reconnect. Published once per ready barrier as the
 * compensation trigger so upper layers can start HTTP reconcile with a stable
 * last-event and runtime generation snapshot.
 *
 * `isReconnect` is false on the clean first ready (no recovery context) and
 * true when a recovery context was captured for a real gap. Ticket 07 can
 * filter real reconnects while still observing every ready edge.
 */
export type EventPipelineCompensationTrigger = {
  lastEventId: string | null
  disconnectedAt: number | null
  runtimeGeneration: number
  reason: string
  transport: "ws" | "sse"
  /** False for first ready; true when a disconnect/visibility/resume gap was captured. */
  isReconnect: boolean
}

/**
 * Snapshot published the first time a recovery gap is fixed for the current
 * disconnect cycle — before any replay merge. Covers transport errors,
 * visibility hidden, pageshow (bfcache), system resume, and online-driven
 * reconnect. Ticket 07 writes Query recovery checkpoints from this edge only
 * (not from `onDisconnect`, which may not fire for visibility-only captures).
 */
export type EventPipelineRecoveryContextCapture = {
  lastEventId: string | null
  disconnectedAt: number
  runtimeGeneration: number
  reason: string
}

export type EventPipelineInput = {
  sdk: OpencodeClient
  onEvent: (directory: string, payload: Event) => void
  routeDirectory?: (directory: string, payload: Event) => string
  /**
   * Optional hook for current-event domain hints (admission, activity, terminal)
   * after normalization and before the legacy Event reducer path.
   */
  onNormalizedEvent?: (directory: string, normalized: NormalizedOpenCodeEvent) => void
  /** Called after stream reconnects (visibility restore or heartbeat timeout). */
  onReconnect?: () => void
  /**
   * Called once per ready barrier after any queued replay events flush.
   * Carries the disconnect-time recovery context when one was captured.
   */
  onCompensation?: (trigger: EventPipelineCompensationTrigger) => void
  /**
   * Called once when a recovery gap context is first fixed (before replay).
   * Fires for visibility_hidden / pageshow_persisted / system_resume / online
   * even when `onDisconnect` does not run. At most once per gap cycle.
   */
  onRecoveryContextCaptured?: (context: EventPipelineRecoveryContextCapture) => void
  /**
   * Called when the stream disconnects (heartbeat timeout, network error, or
   * transport failure). Owns connection UI/state only — transcript checkpoints
   * use `onRecoveryContextCaptured` so visibility-only gaps are not missed.
   */
  onDisconnect?: (reason: string) => void
  /** Called for every transport frame, including SSE comments and heartbeats. */
  onTransportActivity?: () => void
  /** Called when transport switches (e.g. WS timeout → SSE fallback) without actual disconnection. */
  onTransportSwitch?: () => void
  transport?: "auto" | "ws" | "sse"
  heartbeatTimeoutMs?: number
  reconnectDelayMs?: number
  wsReadyTimeoutMs?: number
}

export type EventPipeline = {
  cleanup: () => void
  reconnect: (reason?: string) => void
}

type CapturedRecoveryContext = {
  lastEventId: string | null
  disconnectedAt: number
  runtimeGeneration: number
  reason: string
}

type MessageStreamWsFrame = {
  type: "ready" | "event" | "error" | "backpressure"
  payload?: unknown
  eventId?: string
  directory?: string
  message?: string
  scope?: "global" | "directory"
}

const normalizeOpenChamberSessionStatus = (payload: Event): Event | null => {
  const record = payload as unknown as {
    id?: unknown
    type?: unknown
    properties?: {
      sessionID?: unknown
      sessionId?: unknown
      status?: unknown
      metadata?: {
        attempt?: unknown
        message?: unknown
        next?: unknown
      }
    }
  }

  if (record.type !== "openchamber:session-status") return null

  const sessionID = typeof record.properties?.sessionID === "string" && record.properties.sessionID.length > 0
    ? record.properties.sessionID
    : typeof record.properties?.sessionId === "string" && record.properties.sessionId.length > 0
      ? record.properties.sessionId
      : ""
  const rawStatus = typeof record.properties?.status === "string" ? record.properties.status : ""
  if (!sessionID || !rawStatus) return null

  let status: SessionStatus | null = null
  if (rawStatus === "idle" || rawStatus === "busy") {
    status = { type: rawStatus }
  } else if (rawStatus === "retry") {
    const metadata = record.properties?.metadata
    if (
      typeof metadata?.attempt === "number"
      && typeof metadata.message === "string"
      && typeof metadata.next === "number"
    ) {
      status = {
        type: "retry",
        attempt: metadata.attempt,
        message: metadata.message,
        next: metadata.next,
      }
    }
  }
  if (!status) return null

  return {
    id: typeof record.id === "string" && record.id.length > 0
      ? record.id
      : `openchamber-status-${sessionID}-${Date.now()}`,
    type: "session.status",
    properties: {
      sessionID,
      status,
    },
  } as Event
}

/**
 * Ingress normalization: openchamber synthetic status, then pure OpenCode
 * envelope normalizer (legacy properties / current data / durable sync filter /
 * versioned type strip), producing the legacy Event shape for reducers.
 */
/**
 * Ingress classification.
 *
 * `declined` is NOT a fault: the frame was a well-formed event that the
 * normalizer intentionally refused (currently OpenCode's durable `sync`
 * replicas, filtered so one logical event is not applied twice). The frame was
 * received and handled — the resume tip must advance past it, or a reconnect
 * replays the same frame forever.
 *
 * `unusable` means the frame carried nothing that could be read as an event.
 */
type IngressResult =
  | { status: "event"; event: Event; normalized: NormalizedOpenCodeEvent }
  | { status: "declined" }
  | { status: "unusable" }

const normalizeIngressEvent = (payload: unknown): IngressResult => {
  if (!payload || typeof payload !== "object") return { status: "unusable" }

  // openchamber:session-status → canonical session.status before general path
  const openChamber = normalizeOpenChamberSessionStatus(payload as Event)
  if (openChamber) {
    const props = openChamber.properties as Record<string, unknown>
    return {
      status: "event",
      event: openChamber,
      normalized: {
        id: typeof openChamber.id === "string" ? openChamber.id : undefined,
        type: "session.status",
        properties: props,
      },
    }
  }

  const result = normalizeOpenCodeEvent(payload)
  if (result.action === "drop") {
    return result.reason === "sync-duplicate" ? { status: "declined" } : { status: "unusable" }
  }

  const legacy = toLegacyEventShape(result.event)
  return {
    status: "event",
    event: legacy as Event,
    normalized: result.event,
  }
}

function resolveEventDirectory(
  event: unknown,
  rawPayload: unknown,
  payload: Event,
  locationDirectory?: string,
): string {
  const hasCurrentDataEnvelope =
    typeof rawPayload === "object"
    && rawPayload !== null
    && typeof (rawPayload as { data?: unknown }).data === "object"
    && (rawPayload as { data?: unknown }).data !== null
  if (hasCurrentDataEnvelope && locationDirectory && locationDirectory.length > 0) {
    return locationDirectory
  }

  const directDirectory =
    typeof event === "object" && event !== null && typeof (event as { directory?: unknown }).directory === "string"
      ? (event as { directory: string }).directory
      : null

  if (directDirectory && directDirectory.length > 0) {
    return directDirectory
  }

  if (locationDirectory && locationDirectory.length > 0) {
    return locationDirectory
  }

  const properties =
    typeof payload.properties === "object" && payload.properties !== null
      ? (payload.properties as Record<string, unknown>)
      : null
  const propertyDirectory = typeof properties?.directory === "string" ? properties.directory : null
  if (propertyDirectory && propertyDirectory.length > 0) {
    return propertyDirectory
  }

  // session.created / session.updated carry directory inside properties.info
  const info =
    typeof properties?.info === "object" && properties.info !== null
      ? (properties.info as Record<string, unknown>)
      : null
  const infoDirectory = typeof info?.directory === "string" ? info.directory : null
  if (infoDirectory && infoDirectory.length > 0) {
    return infoDirectory
  }

  return "global"
}

function resolveEventPayload(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const record = payload as { type?: unknown; payload?: unknown; data?: unknown }
  if (typeof record.type === "string") {
    return payload
  }

  if (record.payload && typeof record.payload === "object" && typeof (record.payload as { type?: unknown }).type === "string") {
    return record.payload
  }

  return null
}

function buildGlobalEventWsUrl(lastEventId?: string): string {
  let baseUrl = "/api"
  try {
    const client = opencodeClient as { getBaseUrl?: () => string }
    if (typeof client.getBaseUrl === "function") {
      baseUrl = client.getBaseUrl()
    }
  } catch {
    baseUrl = "/api"
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return getRuntimeUrlResolver().websocket(
    `${normalizedBase}global/event/ws`,
    lastEventId && lastEventId.length > 0 ? { lastEventId } : undefined,
  )
}

// In relay mode the global-event WebSocket rides the E2EE tunnel instead of a
// native network socket. The resolver still builds the authenticated URL (it
// carries the oc_url_token the host replays to the loopback origin); we hand
// its path+query to the tunnel, which returns a socket-like with the exact
// on* handler surface this pipeline uses. Direct-URL runtimes keep the native
// WebSocket path, wrapped to the same shape so the caller holds one type.
function openGlobalEventSocket(lastEventId?: string): RelayTunnelWebSocket {
  const url = buildGlobalEventWsUrl(lastEventId)
  return openRuntimeWebSocket(url)
}

type DirectoryQueue = {
  queue: Event[]
  buffer: Event[]
  coalesced: Map<string, number>
  timer: ReturnType<typeof setTimeout> | undefined
  last: number
}

type AttemptAbortReason =
  | "pipeline_stopped"
  | `${"ws" | "sse"}_${string}`
  | null

export function createEventPipeline(input: EventPipelineInput): EventPipeline {
  const {
    sdk,
    onEvent,
    onNormalizedEvent,
    onReconnect,
    onCompensation,
    onRecoveryContextCaptured,
    onDisconnect,
    onTransportActivity,
    onTransportSwitch,
    routeDirectory,
    transport = "auto",
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    wsReadyTimeoutMs = DEFAULT_WS_READY_TIMEOUT_MS,
  } = input
  const abort = new AbortController()
  let disconnected = false
  let lastEventId: string | undefined
  let wsFallbackUntil = 0
  // Poison-frame guard. The server resumes from lastEventId, so a frame this
  // client can never read would otherwise be replayed into the same rejection
  // on every reconnect and pin the stream at one position. Track repeats of a
  // single eventId and, once the failure proves reproducible, step over it.
  let unusableFrameEventId: string | undefined
  let unusableFrameStrikes = 0
  // Earliest gap snapshot for the current disconnect cycle. Cleared when ready
  // publishes the one-shot compensation trigger for that gap.
  let recoveryContext: CapturedRecoveryContext | null = null

  const directories = new Map<string, DirectoryQueue>()

  const getOrCreateDir = (directory: string): DirectoryQueue => {
    let d = directories.get(directory)
    if (d) return d
    d = {
      queue: [],
      buffer: [],
      coalesced: new Map(),
      timer: undefined,
      last: 0,
    }
    directories.set(directory, d)
    return d
  }

  const key = (payload: Event): string | undefined => {
    if (payload.type === "session.status") {
      const props = payload.properties as { sessionID: string }
      return `session.status:${props.sessionID}`
    }
    if (payload.type === "session.updated") {
      const props = payload.properties as { info?: { id?: string } }
      return props.info?.id ? `session.updated:${props.info.id}` : undefined
    }
    if (payload.type === "lsp.updated") {
      return "lsp.updated"
    }
    if (payload.type === "message.part.delta") {
      const props = payload.properties as { messageID: string; partID: string; field: string }
      return `message.part.delta:${props.messageID}:${props.partID}:${props.field}`
    }
    return undefined
  }

  const flushDir = (directory: string) => {
    const d = directories.get(directory)
    if (!d) return
    if (d.timer) {
      clearTimeout(d.timer)
      d.timer = undefined
    }
    if (d.queue.length === 0) return

    const events = d.queue
    d.queue = d.buffer
    d.buffer = events
    d.queue.length = 0
    d.coalesced.clear()

    d.last = Date.now()
    syncDebug.pipeline.flush(events.length)
    for (const payload of events) {
      onEvent(directory, payload)
    }

    d.buffer.length = 0
  }

  const flushAll = () => {
    for (const directory of directories.keys()) {
      flushDir(directory)
    }
  }

  const scheduleDir = (directory: string) => {
    const d = getOrCreateDir(directory)
    if (d.timer) return
    const elapsed = Date.now() - d.last
    const flushFrameMs = Date.now() < backpressureUntil ? BACKPRESSURE_FLUSH_FRAME_MS : FLUSH_FRAME_MS
    d.timer = setTimeout(() => flushDir(directory), Math.max(0, flushFrameMs - elapsed))
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError" ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")

  const isOffline = (): boolean =>
    typeof navigator === "object" && navigator !== null && navigator.onLine === false

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState !== "visible"

  // Extract an HTTP status code from anywhere it might be hiding on the
  // error object. The SDK's unwrap pattern stashes it on `.status`; raw
  // fetch failures may carry `.response.status`; some SDKs also use `.code`.
  const extractStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== "object") return undefined
    const direct = (error as { status?: unknown }).status
    if (typeof direct === "number") return direct
    const fromResponse = (error as { response?: { status?: unknown } }).response?.status
    if (typeof fromResponse === "number") return fromResponse
    return undefined
  }

  // 4xx errors don't recover from blind retry — wrong path, expired auth,
  // bad request body. Keep retrying anyway (a remote reconfigure or reauth
  // can fix the underlying problem) but at the long cap so we're not
  // hammering the server at 5s intervals indefinitely. 408 (timeout) and
  // 429 (rate limit) are retryable in spirit — let them through to the
  // normal exponential path.
  const isPermanentHttpStatus = (status: number): boolean => {
    if (status < 400 || status >= 500) return false
    if (status === 408 || status === 429) return false
    return true
  }

  /**
   * Wait between reconnect attempts. Resolves early when:
   *   - the browser fires `online` (network came back — probe immediately),
   *   - the tab becomes visible (user came back — probe immediately),
   *   - the OS wakes from sleep (`openchamber:system-resume` — the dead
   *     connection was already torn down, so probe immediately),
   *   - the pipeline is being torn down (cleanup aborts).
   * Otherwise resolves after `ms` like a plain timer.
   */
  const waitForRetry = (ms: number) => new Promise<void>((resolve) => {
    if (ms <= 0 || abort.signal.aborted) {
      resolve()
      return
    }

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (typeof globalThis.window !== "undefined") {
        globalThis.window.removeEventListener("online", onInterrupt)
        globalThis.window.removeEventListener("openchamber:system-resume", onInterrupt)
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityInterrupt)
      }
      abort.signal.removeEventListener("abort", onInterrupt)
    }
    const onInterrupt = () => {
      cleanup()
      resolve()
    }
    const onVisibilityInterrupt = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        onInterrupt()
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onInterrupt, ms)
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.addEventListener("online", onInterrupt, { once: true })
      globalThis.window.addEventListener("openchamber:system-resume", onInterrupt, { once: true })
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityInterrupt)
    }
    abort.signal.addEventListener("abort", onInterrupt, { once: true })
  })

  const computeRetryDelay = (failures: number): number => {
    if (failures <= 0) return 0
    // Offline: don't spin probing a dead network. Use the long cap and rely on
    // waitForRetry to resolve early when the `online` event fires. The cap is
    // also a fallback for browsers that miss `online`.
    if (isOffline()) return RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS
    const cap = isHidden() ? RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS : RETRY_BACKOFF_CAP_VISIBLE_MS
    const exponent = Math.min(failures - 1, RETRY_BACKOFF_MAX_EXPONENT)
    return Math.min(cap, RETRY_BACKOFF_BASE_MS * 2 ** exponent)
  }

  let streamErrorLogged = false
  let attempt: AbortController | undefined
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let activeTransport: "ws" | "sse" = transport === "ws" ? "ws" : "sse"
  let attemptAbortReason: AttemptAbortReason = null
  let consecutiveFailures = 0
  let backpressureUntil = 0

  const captureRecoveryContext = (reason: string) => {
    // Keep the earliest gap in a multi-reason disconnect cycle so
    // disconnectedAt reflects when the client first lost liveness.
    // Publish on first fix only so Ticket 07 can write checkpoints before
    // any later replay merge (visibility/pageshow may never call onDisconnect).
    if (recoveryContext) {
      return
    }
    recoveryContext = {
      lastEventId: lastEventId && lastEventId.length > 0 ? lastEventId : null,
      disconnectedAt: Date.now(),
      runtimeGeneration: getRuntimeGeneration(),
      reason,
    }
    onRecoveryContextCaptured?.({
      lastEventId: recoveryContext.lastEventId,
      disconnectedAt: recoveryContext.disconnectedAt,
      runtimeGeneration: recoveryContext.runtimeGeneration,
      reason: recoveryContext.reason,
    })
  }

  const notifyDisconnected = (reason: string) => {
    if (disconnected) {
      return
    }
    disconnected = true
    captureRecoveryContext(reason)
    // Connection UI/state only — checkpoint capture is onRecoveryContextCaptured.
    onDisconnect?.(reason)
  }

  const publishCompensationTrigger = () => {
    const context = recoveryContext
    recoveryContext = null
    const isReconnect = context !== null
    onCompensation?.({
      lastEventId: context?.lastEventId
        ?? (lastEventId && lastEventId.length > 0 ? lastEventId : null),
      disconnectedAt: context?.disconnectedAt ?? null,
      runtimeGeneration: context?.runtimeGeneration ?? getRuntimeGeneration(),
      reason: context?.reason ?? "ready",
      transport: activeTransport,
      isReconnect,
    })
  }

  const markConnected = () => {
    disconnected = false
    consecutiveFailures = 0
    // Flush any replay/live events already enqueued so the reducer merges
    // them before the ready-barrier compensation trigger starts HTTP work.
    flushAll()
    // Fire onReconnect on every successful connect — including the very
    // first one. Consumer state (isConnected) starts at false and needs
    // to be flipped positively; without this the send button throws
    // "Connection lost" until something else (HTTP health check) happens
    // to race a setState({isConnected: true}) through.
    onReconnect?.()
    // One compensation trigger per ready barrier (including upstream-ready
    // edges that keep the browser WS open). Upper layers use this for
    // transcript HTTP reconcile after replay events have been flushed.
    publishCompensationTrigger()
  }

  const enqueueEvent = (
    directory: string,
    payload: Event,
    normalized?: NormalizedOpenCodeEvent,
  ) => {
    // Current session.next.* body streams are not legacy Message/Part events.
    // Emit domain hints only — skip the Event reducer queue so we do not
    // invent fake message.part deltas.
    if (normalized && typeof normalized.type === "string" && normalized.type.startsWith("session.next.")) {
      onNormalizedEvent?.(directory, normalized)
      // session.status is never under session.next; admission/activity only.
      return
    }

    if (normalized) {
      onNormalizedEvent?.(directory, normalized)
    }

    const normalizedPayload = payload
    const routedDirectory = routeDirectory?.(directory, normalizedPayload) || directory
    const d = getOrCreateDir(routedDirectory)

    // A full part snapshot is a coalescing barrier for that part's deltas:
    // drop its pending delta coalescing keys so a delta arriving after the
    // snapshot starts a fresh queue entry instead of merging into a delta
    // queued before the snapshot, which the snapshot would then overwrite and
    // drop the later delta's text. The already-queued delta event stays.
    if (normalizedPayload.type === "message.part.updated") {
      const part = (normalizedPayload.properties as { part?: { id?: unknown; messageID?: unknown } }).part
      const messageID = typeof part?.messageID === "string" ? part.messageID : undefined
      const partID = typeof part?.id === "string" ? part.id : undefined
      if (messageID && partID) {
        const deltaPrefix = `message.part.delta:${messageID}:${partID}:`
        for (const coalesceKey of d.coalesced.keys()) {
          if (coalesceKey.startsWith(deltaPrefix)) {
            d.coalesced.delete(coalesceKey)
          }
        }
      }
    }

    const k = key(normalizedPayload)
    if (k) {
      const i = d.coalesced.get(k)
      if (i !== undefined) {
        if (normalizedPayload.type === "message.part.delta") {
          const prev = d.queue[i] as unknown as { properties: { delta: string } }
          const inc = normalizedPayload.properties as { delta: string }
          d.queue[i] = {
            ...normalizedPayload,
            properties: {
              ...(normalizedPayload.properties as object),
              delta: prev.properties.delta + inc.delta,
            },
          } as unknown as Event
        } else {
          d.queue[i] = normalizedPayload
        }
        syncDebug.pipeline.coalesced(normalizedPayload.type, k)
        return
      }
      d.coalesced.set(k, d.queue.length)
    }

    d.queue.push(normalizedPayload)
    scheduleDir(routedDirectory)
  }

  /**
   * `ingested` — normalized and enqueued.
   * `declined` — a readable frame the normalizer intentionally skipped. Callers
   *   must treat it as delivered and advance the resume tip; it is not a fault.
   * `unusable` — nothing event-shaped in the frame. Only this is a transport
   *   fault, and only it may hold the resume tip back.
   */
  const ingestTransportPayload = (
    frame: unknown,
    rawPayload: unknown,
  ): "ingested" | "declined" | "unusable" => {
    const payload = resolveEventPayload(rawPayload)
    if (!payload) return "unusable"
    const ingress = normalizeIngressEvent(payload)
    if (ingress.status !== "event") {
      return ingress.status === "declined" ? "declined" : "unusable"
    }
    const directory = resolveEventDirectory(
      frame,
      payload,
      ingress.event,
      ingress.normalized.locationDirectory,
    )
    enqueueEvent(directory, ingress.event, ingress.normalized)
    return "ingested"
  }

  const armHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attemptAbortReason = `${activeTransport}_heartbeat_timeout`
      attempt?.abort()
    }, heartbeatTimeoutMs)
  }

  const reportTransportActivity = () => {
    armHeartbeat()
    onTransportActivity?.()
  }

  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const awaitWithAttemptAbort = async <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    let onAbort: (() => void) | undefined
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("Aborted", "AbortError"))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, abortPromise])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  const runSseAttempt = async (signal: AbortSignal) => {
    armHeartbeat()
    const events = await awaitWithAttemptAbort(sdk.global.event({
      signal,
      ...(lastEventId && lastEventId.length > 0 ? { headers: { "Last-Event-ID": lastEventId } } : {}),
      onSseEvent: (event: { id?: unknown }) => {
        reportTransportActivity()
        if (typeof event.id === "string" && event.id.length > 0) {
          lastEventId = event.id
        }
      },
      onSseError: (error: unknown) => {
        if (isAbortError(error)) return
        if (streamErrorLogged) return
        streamErrorLogged = true
        console.error("[event-pipeline] SSE stream error", error)
      },
    }), signal)

    markConnected()

    let yielded = Date.now()
    reportTransportActivity()

    for await (const event of events.stream) {
      reportTransportActivity()
      streamErrorLogged = false

      ingestTransportPayload(event, (event as { payload?: unknown }).payload ?? event)

      if (Date.now() - yielded < STREAM_YIELD_MS) continue
      yielded = Date.now()
      await wait(0)
    }
    if (!signal.aborted) {
      const error = new Error("Global event SSE stream closed")
      ;(error as Error & { reason?: string }).reason = "sse_stream_closed"
      throw error
    }
  }

  const runWsAttempt = async (signal: AbortSignal) => {
    // A WebSocket upgrade can't carry an Authorization header, so it
    // authenticates purely via the oc_url_token query param. The sync token
    // getter returns "" while the token is unminted or inside its expiry skew
    // window, which would open the socket WITHOUT credentials — the server then
    // rejects it ("HTTP Authentication failed; no valid credentials available")
    // and the resulting reconnect storm churns the sync store (transient
    // status-missing → idle flicker). Mint/await a valid token BEFORE
    // connecting. (SSE avoids this: the SDK fetch sends the bearer header.)
    try {
      await refreshRuntimeUrlAuthToken()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error("Message stream WebSocket auth token unavailable")
      if (transport === "auto") {
        wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
        ;(wrapped as Error & { code?: string }).code = "WS_FALLBACK"
      }
      ;(wrapped as Error & { reason?: string }).reason = "ws_auth_token_unavailable"
      throw wrapped
    }
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let opened = false
      let readyAt = 0
      const socket: RelayTunnelWebSocket = openGlobalEventSocket(lastEventId)
      const setFallbackCode = (error: Error, force = false) => {
        if ((force || !opened) && transport === "auto") {
          wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
          ;(error as Error & { code?: string }).code = "WS_FALLBACK"
        }
      }

      let readyTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        readyTimer = undefined
        const error = new Error("Message stream WebSocket ready timeout")
        setFallbackCode(error)
        settleReject(error)
        try {
          socket.close()
        } catch {
          // ignore
        }
      }, wsReadyTimeoutMs)

      const cleanup = () => {
        if (readyTimer) {
          clearTimeout(readyTimer)
          readyTimer = undefined
        }
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
      }

      const settleResolve = () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        resolve()
      }

      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", handleAbort)
        cleanup()
        reject(error)
      }

      const handleAbort = () => {
        try {
          socket.close()
        } catch {
          // ignore close failures during abort
        }
        settleResolve()
      }

      signal.addEventListener("abort", handleAbort, { once: true })

      socket.onopen = () => {
        // Don't clear streamErrorLogged here. If the socket immediately closes
        // before sending the ready frame, clearing would cause log spam.
      }

      // Protocol-frame failures are real transport faults: preserve the last
      // successfully ingested eventId, capture recovery via the main-loop
      // disconnect path, close the socket, and prefer SSE in auto mode. Never
      // report activity for bad frames (would postpone heartbeat recovery),
      // and never log frame bodies or other sensitive payload data.
      const rejectInvalidFrame = (reason: string) => {
        if (transport === "auto") {
          wsFallbackUntil = Date.now() + WS_FALLBACK_WINDOW_MS
        }
        const error = new Error("Message stream WebSocket invalid frame")
        ;(error as Error & { reason?: string }).reason = reason
        settleReject(error)
        try {
          socket.close()
        } catch {
          // ignore
        }
      }

      socket.onmessage = (messageEvent) => {
        let frame: MessageStreamWsFrame | null = null
        try {
          frame = JSON.parse(String(messageEvent.data)) as MessageStreamWsFrame
        } catch {
          rejectInvalidFrame("ws_invalid_frame:json")
          return
        }

        if (!frame || typeof frame.type !== "string") {
          rejectInvalidFrame("ws_invalid_frame:type")
          return
        }

        if (frame.type === "ready") {
          reportTransportActivity()
          opened = true
          readyAt = Date.now()
          if (readyTimer) {
            clearTimeout(readyTimer)
            readyTimer = undefined
          }
          streamErrorLogged = false
          markConnected()
          return
        }

        if (frame.type === "error") {
          reportTransportActivity()
          const error = new Error(frame.message || "Message stream WebSocket error")
          ;(error as Error & { reason?: string }).reason = `ws_error_frame:${frame.message || "unknown"}`
          setFallbackCode(error)
          settleReject(error)
          try {
            socket.close()
          } catch {
            // ignore
          }
          return
        }

        if (frame.type === "backpressure") {
          reportTransportActivity()
          backpressureUntil = Date.now() + BACKPRESSURE_MODE_MS
          return
        }

        if (frame.type !== "event") {
          rejectInvalidFrame("ws_invalid_frame:type")
          return
        }

        const frameEventId = typeof frame.eventId === "string" && frame.eventId.length > 0
          ? frame.eventId
          : undefined

        const outcome = ingestTransportPayload(
          { directory: frame.directory, payload: frame.payload },
          frame.payload,
        )

        if (outcome === "unusable") {
          if (frameEventId) {
            unusableFrameStrikes = unusableFrameEventId === frameEventId ? unusableFrameStrikes + 1 : 1
            unusableFrameEventId = frameEventId
            if (unusableFrameStrikes >= UNUSABLE_FRAME_SKIP_AFTER) {
              lastEventId = frameEventId
              unusableFrameEventId = undefined
              unusableFrameStrikes = 0
            }
          }
          rejectInvalidFrame("ws_invalid_frame:event_payload")
          return
        }

        // `declined` frames were read successfully and skipped on purpose, so
        // they count as delivered for both activity and resume purposes.
        unusableFrameEventId = undefined
        unusableFrameStrikes = 0
        reportTransportActivity()
        streamErrorLogged = false
        if (frameEventId) {
          lastEventId = frameEventId
        }
      }

      socket.onerror = () => {
        void 0
      }

      socket.onclose = (event) => {
        if (signal.aborted) {
          settleResolve()
          return
        }

        const error = new Error("Global message stream WebSocket closed")
        ;(error as Error & { reason?: string }).reason = opened
          ? `ws_closed:code=${event?.code ?? "?"}`
          : "ws_closed_before_ready"

        // Closed before the socket ever opened → the server rejected the
        // upgrade, typically an auth failure on the oc_url_token. Drop the
        // cached token so the next attempt mints a fresh one instead of
        // replaying a token the server won't accept (which would loop).
        if (!opened) {
          clearRuntimeUrlAuthToken()
        }

        // If the WS stream connects (ready) but then drops quickly, prefer SSE for a while.
        // This avoids tight reconnect loops with repeated console spam.
        const livedMs = readyAt > 0 ? Date.now() - readyAt : 0
        const unstableAfterReady = opened && livedMs > 0 && livedMs < 2_000
        setFallbackCode(error, unstableAfterReady)
        settleReject(error)
      }
    })
  }

  const resolveTransport = (): "ws" | "sse" => {
    if (typeof WebSocket !== "function") {
      return "sse"
    }
    if (transport === "ws") {
      return "ws"
    }
    if (transport === "sse") {
      return "sse"
    }
    return wsFallbackUntil > Date.now() ? "sse" : "ws"
  }

  void (async () => {
    while (!abort.signal.aborted) {
      attempt = new AbortController()
      lastEventAt = Date.now()
      attemptAbortReason = null
      let retryDelayMs = reconnectDelayMs
      const currentTransport = resolveTransport()
      activeTransport = currentTransport
      const onAbort = () => {
        attemptAbortReason = "pipeline_stopped"
        attempt?.abort()
      }
      abort.signal.addEventListener("abort", onAbort)

      try {
        if (currentTransport === "ws") {
          await runWsAttempt(attempt.signal)
        } else {
          await runSseAttempt(attempt.signal)
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
        if (currentTransport === "ws" && code === "WS_FALLBACK") {
          retryDelayMs = 0
          // Transport switch (WS → SSE fallback), not a real disconnection.
          // The consumer still gets a hook so it can resync authoritative
          // state; real networks can lose/buffer events around transport flips.
          onTransportSwitch?.()
        } else if (!isAbortError(error)) {
          consecutiveFailures += 1
          if (!streamErrorLogged) {
            streamErrorLogged = true
            console.error("[event-pipeline] stream failed", error)
          }
          // Notify consumer that the stream has disconnected, so it can
          // update connection state (e.g. set isConnected = false).
          // Guard: only fire once per disconnection cycle to avoid repeated
          // setState calls on every failed retry attempt.
          const taggedReason = typeof error === "object" && error !== null
            ? (error as { reason?: unknown }).reason
            : undefined
          const message = typeof error === "object" && error !== null
            ? (error as { message?: unknown }).message
            : undefined
          const reason = typeof taggedReason === "string" && taggedReason.length > 0
            ? taggedReason
            : typeof message === "string" && message.length > 0
              ? `${currentTransport}_error:${message.slice(0, 80)}`
              : `${currentTransport}_error:unknown`
          notifyDisconnected(reason)

          // Exponential backoff so a hard-down server / dead network doesn't
          // spin the event loop. Caps lower (5s) when the user is foreground
          // and the browser thinks it's online; caps higher (60s) when hidden
          // or offline so a backgrounded PWA on a flaky link doesn't burn
          // battery. waitForRetry below resolves early on `online` or
          // visibility-visible so recovery is still under a second.
          //
          // Override for permanent 4xx errors: stuck-path / bad-auth scenarios
          // won't recover from blind retry. Use the long cap immediately so
          // the client doesn't pound the server log at 12 reqs/min. The
          // waitForRetry interrupters still apply, so a fix on the other end
          // followed by `online`/visibility recovery probes promptly.
          const status = extractStatus(error)
          if (status !== undefined && isPermanentHttpStatus(status)) {
            retryDelayMs = RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS
          } else {
            retryDelayMs = computeRetryDelay(consecutiveFailures)
          }
        }
      } finally {
        abort.signal.removeEventListener("abort", onAbort)
        attempt = undefined
        clearHeartbeat()
      }

      if (abort.signal.aborted) return
      if (attemptAbortReason && attemptAbortReason !== "pipeline_stopped") {
        notifyDisconnected(attemptAbortReason)
        consecutiveFailures += 1
        retryDelayMs = reconnectDelayMs > 0 ? computeRetryDelay(consecutiveFailures) : 0
        attemptAbortReason = null
      }
      if (retryDelayMs > 0) {
        await waitForRetry(retryDelayMs)
      }
    }
  })().finally(flushAll)

  const onVisibility = () => {
    if (typeof document === "undefined") return
    if (document.visibilityState === "hidden") {
      // Capture recovery context while the last known event id is still
      // current so a later ready can compensate from the pre-hide tip.
      captureRecoveryContext("visibility_hidden")
      return
    }
    if (document.visibilityState !== "visible") return
    if (Date.now() - lastEventAt < heartbeatTimeoutMs) return
    attempt?.abort()
  }

  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    captureRecoveryContext("pageshow_persisted")
    attempt?.abort()
  }

  // OS wake-from-sleep (Electron powerMonitor.resume). The SSE connection
  // is almost certainly dead after sleep — abort immediately so the
  // reconnect loop fires on the next tick with retryDelayMs = 0.
  const onSystemResume = () => {
    captureRecoveryContext("system_resume")
    if (!attempt) return
    attemptAbortReason = `${activeTransport}_system_resume`
    attempt.abort()
  }

  // Browser told us the network is back. If we're already in a disconnected
  // cycle, abort the (stale) attempt and let the loop probe immediately;
  // waitForRetry also resolves early on `online`, so any inter-attempt sleep
  // ends now. Guard on `disconnected` so a spurious `online` from the browser
  // doesn't disrupt a healthy connection.
  const onOnline = () => {
    if (!disconnected) return
    captureRecoveryContext("online")
    attempt?.abort()
  }

  // Browser told us we're offline. Abort the current attempt — its socket /
  // fetch will throw soon anyway, this just stops sooner. computeRetryDelay
  // then returns the long cap so we wait for `online` instead of hammering
  // a dead network.
  const onOffline = () => {
    attempt?.abort()
  }

  const reconnect = (reason = "manual") => {
    attemptAbortReason = `${activeTransport}_${reason}`
    attempt?.abort()
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
  }

  // Use globalThis (not window) for the system-resume listener so that
  // test environments can replace globalThis.window with a stub.
  if (typeof globalThis.window !== "undefined") {
    globalThis.window.addEventListener("openchamber:system-resume", onSystemResume)
    globalThis.window.addEventListener("online", onOnline)
    globalThis.window.addEventListener("offline", onOffline)
  }

  const cleanup = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
    }
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.removeEventListener("openchamber:system-resume", onSystemResume)
      globalThis.window.removeEventListener("online", onOnline)
      globalThis.window.removeEventListener("offline", onOffline)
    }
    abort.abort()
    clearHeartbeat()
    flushAll()
  }

  return { cleanup, reconnect }
}
