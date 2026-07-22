/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { reduceGlobalEvent, applyGlobalProject, applyDirectoryEvent, type SessionMaterializationReason } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from "./live-aggregate"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { retry } from "./retry"
import { updateStreamingState } from "./streaming"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { applySessionEventToGlobalSessions } from "./session-event-router"
import { syncDebug } from "./debug"
import {
  getReconnectCandidateSessionIds,
  getReconnectMaterializationSessionIds,
  getStatusWatchdogCandidateSessionIds,
} from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import { toast } from "@/components/ui"
import { appendNotification } from "./notification-store"
import { applyGlobalSessionStatusEvent, useGlobalSessionStatusStore } from "./global-session-status"
import { applyWorktreeBootstrapStatusEvent } from "@/lib/worktrees/worktreeBootstrap"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import * as sessionActions from "./session-actions"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { openSessionFromToast } from "./session-opener"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { getSessionPrefetch, setSessionPrefetch, subscribeSessionPrefetch, type SessionPrefetchMeta } from "./session-prefetch-cache"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests } from "./scoped-blocking-requests"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type UserMessageHistorySnapshot } from "./user-message-history"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { waitForSessionStartupBarrier } from "@/lib/session-startup-barrier"
import {
  readScopedSessionStatus,
  scopedSessionStatusSignature,
  subscribeScopedSessionStatuses,
  type ScopedSessionStatus,
  type ScopedSessionStatusScope,
} from "./scoped-session-status"
import { CURRENT_SESSION_ENTITY_CACHE_TTL_MS, resolveCurrentSessionEntity, resolveParentSessionTarget } from "./current-session-entity"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  sdk: OpencodeClient
  directory: string
}

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (!result.error) return result.data
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(
  selector: (states: State[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  subscribe?: (childStores: ChildStoreManager, notify: () => void) => () => void,
): T {
  const { childStores } = useSyncSystem()
  const cacheRef = useRef<T | undefined>(undefined)
  const initializedRef = useRef(false)

  const getSnapshot = useCallback(() => {
    const next = selector(getLiveStates(childStores))
    if (initializedRef.current && isEqual(cacheRef.current as T, next)) {
      return cacheRef.current as T
    }

    cacheRef.current = next
    initializedRef.current = true
    return next
  }, [childStores, isEqual, selector])

  return React.useSyncExternalStore(
    useCallback(
      (notify) => subscribe ? subscribe(childStores, notify) : childStores.subscribeAll(notify),
      [childStores, subscribe],
    ),
    getSnapshot,
    getSnapshot,
  )
}

// ---------------------------------------------------------------------------
// Event handler — applies one SSE event at a time to the live store.
// Each event reads live state, creates a shallow draft, applies, writes back.
// React 18 batches synchronous setState calls automatically.
// ---------------------------------------------------------------------------

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  const liveStatus = useLiveSyncSelector(
    useCallback((states) => findLiveSessionStatus(states, sessionId), [sessionId]),
    Object.is,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session_status?.[sessionId],
        notify,
      ),
      [sessionId],
    ),
  )
  const fallbackStatus = useGlobalSessionStatusStore(
    useCallback((state) => state.statusById.get(sessionId)?.status, [sessionId]),
  )
  return resolveGlobalSessionStatus(liveStatus, fallbackStatus)
}

export function resolveGlobalSessionStatus(
  liveStatus: SessionStatus | undefined,
  fallbackStatus: "busy" | "retry" | undefined,
): SessionStatus | undefined {
  if (liveStatus) {
    return liveStatus
  }
  if (fallbackStatus === "busy") {
    return { type: "busy" }
  }
  if (fallbackStatus === "retry") {
    return { type: "retry", attempt: 0, message: "", next: 0 }
  }
  return undefined
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessionStatuses(states), []),
    areStatusMapsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session_status,
        notify,
      ),
      [],
    ),
  )
}

export function useAllLiveSessions(): Session[] {
  const pendingDeletionIds = useGlobalSessionsStore((state) => state.pendingDeletionIds)
  return useLiveSyncSelector(
    useMemo(() => (states: State[]) => aggregateLiveSessions(states, pendingDeletionIds), [pendingDeletionIds]),
    areSessionListsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session,
        notify,
      ),
      [],
    ),
  )
}

// Boot debounce — suppresses redundant refresh/re-bootstrap events during startup.
let bootingRoot = false
let bootedAt = 0
let globalBootstrapGeneration = 0
const BOOT_DEBOUNCE_MS = 1500
const RECONNECT_MESSAGE_LIMIT = 30
const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30
const RECONNECT_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STALE_EVENT_MS = 40_000
const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000
const ACTIVE_SESSION_DOMAIN_STALE_MS = 60_000
const ACTIVE_SESSION_DOMAIN_RECOVERY_COOLDOWN_MS = 60_000
const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

// ---------------------------------------------------------------------------
// Session materialization scheduler — when local message/part state is incomplete,
// fetch the canonical session snapshot and materialize messages and parts together.
// Tracked per-directory, deduplicated, and auto-expiring.
// ---------------------------------------------------------------------------

type PendingSessionMaterialization = {
  sessionID: string
  directory: string
  enqueuedAt: number
  request: SessionMaterializationRequest
}

type SessionMaterializationRequest = {
  reason: SessionMaterializationReason
  messageID?: string
  partID?: string
}

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000
const pendingSessionMaterializations = new Map<string, PendingSessionMaterialization>() // key: directory:sessionID

const materializationKey = (directory: string, sessionID: string) => `${directory}:${sessionID}`

function enqueueSessionMaterialization(
  directory: string,
  sessionID: string,
  childStores: ChildStoreManager,
  request: SessionMaterializationRequest,
) {
  if (!directory || directory === "global" || !sessionID) return
  const k = materializationKey(directory, sessionID)
  const existing = pendingSessionMaterializations.get(k)
  if (existing && Date.now() - existing.enqueuedAt < SESSION_MATERIALIZATION_COOLDOWN_MS) return

  pendingSessionMaterializations.set(k, { sessionID, directory, enqueuedAt: Date.now(), request })

  // Defer to next microtask so we don't hold up the current event batch
  void Promise.resolve().then(async () => {
    const store = childStores.getChild(directory)
    if (!store) {
      pendingSessionMaterializations.delete(k)
      return
    }
    try {
      await materializeSessionFromServer(directory, sessionID, store, request)
    } catch {
      // Transient failure — next SSE event or reconnect will catch up.
    } finally {
      pendingSessionMaterializations.delete(k)
    }
  })
}

async function materializeSessionFromServer(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
  options?: SessionMaterializationRequest & { isStale?: () => boolean },
) {
  const statusBeforeMaterialization = store.getState().session_status?.[sessionID]
  syncDebug.recovery.materializing({
    reason: options?.reason ?? "ensure-session-messages",
    directory,
    sessionID,
    messageID: options?.messageID,
    partID: options?.partID,
  })
  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  const result = await retry(async () => {
    const response = await scopedClient.session.messages({ sessionID, limit: SESSION_MATERIALIZATION_MESSAGE_LIMIT })
    assertSdkSuccess(response, "session.messages")
    return response
  })
  const records = (result.data ?? []).filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  if (records.length === 0) return
  const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
  setSessionPrefetch({
    directory,
    sessionID,
    limit: records.length,
    cursor,
    complete: !cursor,
  })

  if (options?.isStale?.()) return

  store.setState((state: DirectoryStore) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionID,
      records.map((record: { info: Message; parts?: Part[] }) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: RECONNECT_SKIP_PARTS },
    )
    if (!materialized.messagesChanged && !materialized.partsChanged) {
      return state
    }
    return { message: materialized.message, part: materialized.part }
  })

  if (statusBeforeMaterialization && statusBeforeMaterialization.type !== "idle" && !options?.isStale?.()) {
    await resyncDirectorySessionStatuses(directory, store, [sessionID])
  }
}

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""
const externallyViewedSessions = new Map<string, number>()
const EXTERNAL_VIEW_TTL_MS = 15_000

const viewedSessionKey = (directory: string, sessionId: string) => `${directory}\n${sessionId}`

function pruneExternallyViewedSessions(now = Date.now()) {
  for (const [key, expiresAt] of externallyViewedSessions.entries()) {
    if (expiresAt <= now) {
      externallyViewedSessions.delete(key)
    }
  }
}
const pendingQuestionToastIds = new Set<string>()
const pendingPermissionToastIds = new Set<string>()

const getQuestionToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

type UiNotificationPayload = {
  title?: unknown
  body?: unknown
  tag?: unknown
  kind?: unknown
  sessionId?: unknown
  directory?: unknown
  requireHidden?: unknown
  desktopNotificationDelivered?: unknown
  desktopStdoutActive?: unknown
}

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const handleUiNotificationEvent = (payload: Event, fallbackDirectory: string): boolean => {
  if ((payload as { type?: unknown }).type !== "openchamber:notification") {
    return false
  }

  const properties = (payload as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return true
  }

  const notification = properties as UiNotificationPayload
  if ((notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true) && getRuntimeKey() === "local") {
    return true
  }

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) {
    return true
  }

  void notifications.notifyAgentCompletion({
    title: asOptionalString(notification.title),
    body: asOptionalString(notification.body),
    tag: asOptionalString(notification.tag),
    kind: asOptionalString(notification.kind),
    sessionId: asOptionalString(notification.sessionId),
    directory: asOptionalString(notification.directory) ?? (fallbackDirectory && fallbackDirectory !== "global" ? fallbackDirectory : undefined),
    requireHidden: notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })

  return true
}

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
}

// The window must actually be focused for the active session to count as
// "seen": if the app is minimized or in the background, a turn finishing in the
// currently-selected session should still raise an unseen marker (in the tray
// and in-app), since the user isn't looking at it.
function isWindowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus()
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (
    _activeDirectory && _activeSession
    && directory === _activeDirectory && sessionId === _activeSession
    && isWindowFocused()
  ) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(directory, sessionId))
}

function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

function getViewedSessionMaterializationTarget(directory: string) {
  if (!_activeDirectory || !_activeSession) return null
  if (directory !== _activeDirectory) return null
  return {
    directory: _activeDirectory,
    sessionId: _activeSession,
  }
}

function toSessionStatus(status: Awaited<ReturnType<typeof opencodeClient.getSessionStatus>>[string] | undefined): SessionStatus | undefined {
  if (!status) return undefined
  if (status.type === "idle" || status.type === "busy") {
    return { type: status.type }
  }
  if (
    status.type === "retry"
    && typeof status.attempt === "number"
    && typeof status.message === "string"
    && typeof status.next === "number"
  ) {
    return {
      type: "retry",
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    }
  }
  return undefined
}

function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

export type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getSessionStatusForDirectory>>
>

// How a /session/status snapshot is reconciled into the store.
//
// The directory-scoped snapshot lists only active (busy/retry) sessions; an
// absent candidate means "idle per this snapshot". Snapshots are one-shot
// (bootstrap / reconnect / escalated resync) — live busy/idle transitions arrive
// via the global event WS (`session.status` / `session.idle`). Treat the
// snapshot as ground truth: absent/idle candidates are lowered to idle, and the
// snapshot wins over any derived message state.
export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  observedAt?: number,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextObservedAt: Record<string, number> | undefined
    const draft = () => (next ??= { ...current })
    const observedDraft = () => (nextObservedAt ??= { ...state.session_status_observed_at })
    const confirmObservedAt = (sessionId: string) => {
      if (observedAt === undefined || state.session_status_observed_at[sessionId] === observedAt) return
      observedDraft()[sessionId] = observedAt
      changed = true
    }

    for (const sessionId of candidateSessionIds) {
      if (observedAt !== undefined && (state.session_status_observed_at[sessionId] ?? -Infinity) >= observedAt) {
        continue
      }
      const incoming = toSessionStatus(snapshot[sessionId])

      if (incoming && incoming.type !== "idle") {
        // Confirm or raise active status (catches a busy event the stream missed).
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        confirmObservedAt(sessionId)
        continue
      }

      // Snapshot reports this candidate idle (absent, or explicit idle).
      const existing = current[sessionId]
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
      confirmObservedAt(sessionId)
    }

    if (!next && !nextObservedAt) return state
    return {
      ...(next ? { session_status: next } : {}),
      ...(nextObservedAt ? { session_status_observed_at: nextObservedAt } : {}),
    }
  })

  return changed
}

export function collectSessionStatusSnapshotApplyIds(
  localCandidateSessionIds: string[],
  snapshot: DirectorySessionStatusSnapshot,
): string[] {
  return Array.from(new Set([
    ...localCandidateSessionIds,
    ...Object.keys(snapshot),
  ]))
}

async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
): Promise<DirectorySessionStatusSnapshot | null> {
  const requestedAt = Date.now()
  const nextStatuses = await opencodeClient.getSessionStatusForDirectory(directory)
  // null = fetch failed; preserve existing state. {} or populated = a snapshot
  // of active sessions — absence means idle for the candidate set.
  if (nextStatuses === null) return null
  // Local reconnect candidates alone miss sessions that went idle→busy while the
  // stream was down. Always union snapshot IDs into the apply set.
  const applyIds = collectSessionStatusSnapshotApplyIds(candidateSessionIds, nextStatuses)
  store.setState({ session_status_snapshot_at: requestedAt })
  applySessionStatusSnapshot(store, nextStatuses, applyIds, requestedAt)
  return nextStatuses
}

// Decide whether the event stream is genuinely stale and warrants a full
// resync. Uses stream activity that includes heartbeats, so a quiet-but-
// connected session (only receiving heartbeats) is NOT considered stale.
// A stale signal means no events at all — including no heartbeats — for the
// configured threshold, which is strong evidence the connection is dead.
// Returns false when lastStreamActivityAt is 0 (no events received yet),
// so the watchdog does not fire before the stream has delivered its first
// heartbeat.
export function shouldTriggerStaleResync(
  lastStreamActivityAt: number,
  lastFullResyncAt: number,
  now: number,
  staleThresholdMs: number = ACTIVE_SESSION_STALE_EVENT_MS,
  resyncCooldownMs: number = ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS,
): boolean {
  if (lastStreamActivityAt <= 0) return false
  if (now - lastStreamActivityAt < staleThresholdMs) return false
  if (now - lastFullResyncAt < resyncCooldownMs) return false
  return true
}

export function shouldTriggerDomainRecovery({
  isViewed,
  status,
  lastTransportActivityAt,
  lastDomainActivityAt,
  lastFullResyncAt,
  now,
  transportStaleThresholdMs = ACTIVE_SESSION_STALE_EVENT_MS,
  domainStaleThresholdMs = ACTIVE_SESSION_DOMAIN_STALE_MS,
  recoveryCooldownMs = ACTIVE_SESSION_DOMAIN_RECOVERY_COOLDOWN_MS,
}: {
  isViewed: boolean
  status: SessionStatus | undefined
  lastTransportActivityAt: number
  lastDomainActivityAt: number
  lastFullResyncAt: number
  now: number
  transportStaleThresholdMs?: number
  domainStaleThresholdMs?: number
  recoveryCooldownMs?: number
}): boolean {
  if (!isViewed || (status?.type !== "busy" && status?.type !== "retry")) return false
  if (lastTransportActivityAt <= 0 || now - lastTransportActivityAt >= transportStaleThresholdMs) return false
  if (lastDomainActivityAt <= 0 || now - lastDomainActivityAt < domainStaleThresholdMs) return false
  if (now - lastFullResyncAt < recoveryCooldownMs) return false
  return true
}

type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

const SHOULD_DISPATCH_VSCODE_NOTIFICATIONS = isVSCodeRuntime()

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: Event) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
}

const createEventRoutingIndex = (): EventRoutingIndex => ({
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
})

const normalizeEventDirectory = (rawDirectory: string): string => {
  if (!rawDirectory || rawDirectory === "global") {
    return rawDirectory
  }
  const normalized = rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
  // Strip trailing slashes to match child store keys (normalizeDirectoryPath in useDirectoryStore)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

export const getSessionIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const sessionID = (info as { sessionID?: unknown }).sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (
    event.type === "message.removed"
    || event.type === "session.status"
    || event.type === "session.idle"
    || event.type === "session.error"
    || event.type === "todo.updated"
    || event.type === "permission.asked"
    || event.type === "permission.replied"
    || event.type === "question.asked"
    || event.type === "question.replied"
    || event.type === "question.rejected"
    || event.type === "session.deleted"
  ) {
    const sessionID = props.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "message.part.updated") {
    const sessionID = props.sessionID
    if (typeof sessionID === "string" && sessionID.length > 0) {
      return sessionID
    }

    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const partSessionID = (part as { sessionID?: unknown }).sessionID
    return typeof partSessionID === "string" && partSessionID.length > 0 ? partSessionID : null
  }

  if (event.type === "message.part.delta" || event.type === "message.part.removed") {
    const sessionID = props.sessionID
    return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
  }

  if (event.type === "session.created" || event.type === "session.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  return null
}

const getMessageIdFromPayload = (event: Event): string | null => {
  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const props = properties as Record<string, unknown>

  if (event.type === "message.updated") {
    const info = props.info
    if (!info || typeof info !== "object") {
      return null
    }
    const id = (info as { id?: unknown }).id
    return typeof id === "string" && id.length > 0 ? id : null
  }

  if (event.type === "message.removed" || event.type === "message.part.delta" || event.type === "message.part.removed") {
    const messageID = props.messageID
    return typeof messageID === "string" && messageID.length > 0 ? messageID : null
  }

  if (event.type === "message.part.updated") {
    const part = props.part
    if (!part || typeof part !== "object") {
      return null
    }
    const partMessageID = (part as { messageID?: unknown }).messageID
    return typeof partMessageID === "string" && partMessageID.length > 0 ? partMessageID : null
  }

  return null
}

const setIndexedSessionDirectory = (routingIndex: EventRoutingIndex, sessionID: string, directory: string) => {
  if (!sessionID || !directory || directory === "global") {
    return
  }
  routingIndex.sessionDirectoryById.set(sessionID, directory)
}

const setIndexedSessionMessages = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  directory: string,
  messages: Message[],
) => {
  if (!sessionID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)

  const previous = routingIndex.sessionMessageIdsById.get(sessionID)
  const next = new Set<string>()

  for (const message of messages) {
    if (!message?.id) {
      continue
    }
    next.add(message.id)
    routingIndex.messageSessionById.set(message.id, sessionID)
  }

  if (previous) {
    for (const previousMessageID of previous) {
      if (!next.has(previousMessageID)) {
        routingIndex.messageSessionById.delete(previousMessageID)
      }
    }
  }

  routingIndex.sessionMessageIdsById.set(sessionID, next)
}

const setIndexedMessage = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  messageID: string,
  directory: string,
) => {
  if (!sessionID || !messageID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)
  routingIndex.messageSessionById.set(messageID, sessionID)

  const existing = routingIndex.sessionMessageIdsById.get(sessionID)
  if (existing) {
    existing.add(messageID)
  } else {
    routingIndex.sessionMessageIdsById.set(sessionID, new Set([messageID]))
  }
}

const removeIndexedMessage = (
  routingIndex: EventRoutingIndex,
  messageID: string,
  sessionHint?: string | null,
) => {
  if (!messageID) {
    return
  }

  const sessionID = sessionHint ?? routingIndex.messageSessionById.get(messageID)
  routingIndex.messageSessionById.delete(messageID)

  if (!sessionID) {
    return
  }

  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (!messageIds) {
    return
  }

  messageIds.delete(messageID)
  if (messageIds.size === 0) {
    routingIndex.sessionMessageIdsById.delete(sessionID)
  }
}

const removeIndexedSession = (routingIndex: EventRoutingIndex, sessionID: string) => {
  if (!sessionID) {
    return
  }

  routingIndex.sessionDirectoryById.delete(sessionID)
  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (messageIds) {
    for (const messageID of messageIds) {
      routingIndex.messageSessionById.delete(messageID)
    }
  }
  routingIndex.sessionMessageIdsById.delete(sessionID)
}

const ingestDirectoryStateIntoRoutingIndex = (
  routingIndex: EventRoutingIndex,
  directory: string,
  state: State,
) => {
  const nextSessionIds = new Set<string>()

  for (const session of state.session) {
    if (!session?.id) {
      continue
    }
    nextSessionIds.add(session.id)
    setIndexedSessionDirectory(routingIndex, session.id, directory)
  }

  for (const sessionID of Object.keys(state.message)) {
    nextSessionIds.add(sessionID)
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
    setIndexedSessionMessages(routingIndex, sessionID, directory, state.message[sessionID] ?? EMPTY_MESSAGES)
  }

  for (const [indexedSessionID, indexedDirectory] of routingIndex.sessionDirectoryById) {
    if (indexedDirectory !== directory) {
      continue
    }
    if (!nextSessionIds.has(indexedSessionID)) {
      removeIndexedSession(routingIndex, indexedSessionID)
    }
  }
}

const findSessionInChildStores = (
  sessionID: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = store.getState()
    if (
      state.session.some((s) => s.id === sessionID)
      || Object.prototype.hasOwnProperty.call(state.message, sessionID)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
    ) {
      // Self-heal: populate the routing index so future events resolve instantly
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
      return dir
    }
  }
  return null
}

const childStoreHasSessionState = (
  childStores: ChildStoreManager,
  directory: string,
  sessionID: string,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  const state = store.getState()
  return state.session.some((session) => session.id === sessionID)
    || Object.prototype.hasOwnProperty.call(state.message, sessionID)
    || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
}

const childStoreHasMessagePartState = (
  childStores: ChildStoreManager,
  directory: string,
  messageID: string,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  return Object.prototype.hasOwnProperty.call(store.getState().part, messageID)
}

const getActiveDirectoryFallback = (childStores: ChildStoreManager): string | null => {
  if (!_activeDirectory || !_activeSession) return null
  return childStores.getChild(_activeDirectory) ? _activeDirectory : null
}

const resolveDirectoryFromRoutingIndex = (
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
    }

    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    // Routing index miss — scan child stores for this session.
    // Covers optimistic sessions not yet indexed and events with wrong/empty directory.
    const found = findSessionInChildStores(sessionID, childStores, routingIndex)
    if (found) {
      return found
    }
  }

  const messageID = getMessageIdFromPayload(payload)
  if (messageID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasMessagePartState(childStores, normalizedDirectory, messageID)) {
      return normalizedDirectory
    }

    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory && childStores.getChild(indexedDirectory)) {
        return indexedDirectory
      }
    }

    // Scan child stores for a store that has parts for this message
    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(store.getState().part, messageID)) {
        return dir
      }
    }

    // Some reconnect/idle gaps can deliver part events before the matching
    // message.updated event and without a sessionID. If the user is actively
    // viewing a session, route the orphaned part event there so the reducer can
    // trigger HTTP materialization instead of dropping it as a global event.
    const activeDirectory = getActiveDirectoryFallback(childStores)
    if (activeDirectory) {
      return activeDirectory
    }
  }

  // Single-store fallback: if there's only one directory, use it
  if (
    (sessionID || messageID)
    && (!normalizedDirectory || normalizedDirectory === "global")
    && childStores.children.size === 1
  ) {
    const onlyDirectory = childStores.children.keys().next().value
    if (typeof onlyDirectory === "string" && onlyDirectory.length > 0) {
      return onlyDirectory
    }
  }

  return normalizedDirectory
}

const resolveMaterializationSessionID = (
  materializationSessionID: string | undefined,
  messageID: string | undefined,
  resolvedDirectory: string,
  routingIndex: EventRoutingIndex,
): string | undefined => {
  if (materializationSessionID) return materializationSessionID
  if (messageID) {
    const indexedSessionID = routingIndex.messageSessionById.get(messageID)
    if (indexedSessionID) return indexedSessionID
  }
  if (resolvedDirectory && resolvedDirectory === _activeDirectory && _activeSession) {
    return _activeSession
  }
  return undefined
}

export function resolveStrictDomainSessionID(
  payload: Event,
  messageSessionById: ReadonlyMap<string, string>,
): string | undefined {
  const sessionID = getSessionIdFromPayload(payload)
    ?? (payload.type === "session.deleted"
      ? (payload.properties as { info?: { id?: string } }).info?.id
      : undefined)
  if (sessionID) return sessionID
  const messageID = getMessageIdFromPayload(payload)
  return messageID ? messageSessionById.get(messageID) : undefined
}

export function isLiveRevisionCurrent(capturedRevision: number, currentRevision: number): boolean {
  return capturedRevision === currentRevision
}

const isSnapshotRevisionEvent = (payload: Event): boolean => (
  payload.type === "session.created"
  || payload.type === "session.updated"
  || payload.type === "session.deleted"
  || payload.type === "message.updated"
  || payload.type === "message.removed"
  || payload.type === "message.part.updated"
  || payload.type === "message.part.removed"
  || payload.type === "message.part.delta"
)

const updateRoutingIndexFromEvent = (
  routingIndex: EventRoutingIndex,
  directory: string,
  payload: Event,
) => {
  if (!directory || directory === "global") {
    return
  }

  const sessionID = getSessionIdFromPayload(payload)
  if (sessionID) {
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
  }

  switch (payload.type) {
    case "session.created":
    case "session.updated": {
      const info = (payload.properties as { info?: Session }).info
      if (info?.id) {
        setIndexedSessionDirectory(routingIndex, info.id, directory)
      }
      return
    }

    case "session.deleted": {
      const deletedSessionID = (payload.properties as { sessionID?: string }).sessionID
      if (deletedSessionID) {
        removeIndexedSession(routingIndex, deletedSessionID)
      }
      return
    }

    case "message.updated": {
      const info = (payload.properties as { info?: Message }).info
      if (info?.id && info.sessionID) {
        setIndexedMessage(routingIndex, info.sessionID, info.id, directory)
      }
      return
    }

    case "message.removed": {
      const props = payload.properties as { sessionID?: string; messageID?: string }
      if (props.messageID) {
        removeIndexedMessage(routingIndex, props.messageID, props.sessionID)
      }
      return
    }

    case "message.part.updated": {
      const props = payload.properties as { sessionID?: string; part?: Part }
      const part = props.part as (Part & { sessionID?: string; messageID?: string }) | undefined
      const sessionID = part?.sessionID ?? props.sessionID
      const messageID = part?.messageID
      if (messageID && sessionID) {
        setIndexedMessage(routingIndex, sessionID, messageID, directory)
      }
      return
    }

    default:
      return
  }
}

/**
 * Re-fetch pending questions and permissions for a directory and merge them
 * into the directory's child store, preserving any in-flight SSE updates that
 * arrived while the request was pending. Used by reconnect/materialization
 * recovery paths only; normal session switches rely on primary SSE reducer
 * state for `question.asked` / `permission.asked` events. When
 * `candidateSessionIds` is omitted, every session known to the directory store
 * is treated as a candidate.
 */
export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
) {
  const before = store.getState()
  const knownSessionIds = new Set<string>([
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.question ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  const candidates = candidateSessionIds ?? Array.from(knownSessionIds)
  if (candidates.length === 0) return

  // Re-fetch pending questions that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.question[sessionId])]),
    )
    const pendingQuestions = await opencodeClient.listPendingQuestions({ directories: [directory] })
    const grouped: Record<string, QuestionRequest[]> = {}
    for (const q of pendingQuestions) {
      if (!q?.id || !q.sessionID) continue
      if (!knownSessionIds.has(q.sessionID)) continue
      const list = grouped[q.sessionID]
      if (list) list.push(q)
      else grouped[q.sessionID] = [q]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    for (const [sessionId, questions] of Object.entries(grouped)) {
      const knownIds = new Set((before.question[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const question of questions) {
        if (knownIds.has(question.id)) continue
        const toastKey = getQuestionToastKey(sessionId, question.id)
        if (!toastKey || pendingQuestionToastIds.has(toastKey)) continue
        pendingQuestionToastIds.add(toastKey)
        const firstQuestion = question.questions?.[0]
        const title = firstQuestion?.header?.trim() || "Input needed"
        const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
        toast.info(title, {
          id: `question-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(sessionId, directory),
          },
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.question }
      for (const [sessionId, questions] of Object.entries(grouped)) {
        merged[sessionId] = questions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.question[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { question: merged }
    })
  } catch {
    // Non-fatal: question resync best-effort
  }

  // Re-fetch pending permissions — same rationale as questions.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!knownSessionIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const permissionStore = usePermissionStore.getState()
    const autoAcceptingSessionIds = isVSCodeRuntime()
      ? Object.keys(grouped).filter((sessionId) => permissionStore.isSessionAutoAccepting(sessionId))
      : []

    if (autoAcceptingSessionIds.length > 0) {
      const acceptedIdsBySession = new Map<string, Set<string>>()
      // Track server-confirmed resolved permissions separately so we can
      // remove them from `grouped` below — the V1 listPendingPermissions
      // snapshot can still contain entries the server has already answered,
      // and leaving them in place produces a spurious "Permission needed"
      // toast for a permission the user has already resolved.
      const resolvedIdsBySession = new Map<string, Set<string>>()
      await Promise.all(autoAcceptingSessionIds.flatMap((sessionId) =>
        (grouped[sessionId] ?? []).map(async (permission) => {
          try {
            // Verify the permission is still pending before auto-accepting.
            // - state: "ok"        → still pending, safe to auto-accept
            // - state: "resolved"  → server returned 404, drop from grouped
            // - state: "unknown"   → network error / pre-1.17.12 server,
            //                        keep in grouped for the user to act on
            //
            // On a pre-v1.17.12 server without the V2 endpoint, every call
            // returns "unknown". This permanently disables auto-accept
            // (acknowledged scope tradeoff — project requires SDK 1.17.12)
            // but does not falsely report permissions as resolved.
            const outcome = await opencodeClient.fetchPermission(
              permission.sessionID,
              permission.id,
            )
            if (outcome.state === "ok") {
              await sessionActions.respondToPermission(permission.sessionID, permission.id, "once")
              const accepted = acceptedIdsBySession.get(sessionId) ?? new Set<string>()
              accepted.add(permission.id)
              acceptedIdsBySession.set(sessionId, accepted)
            } else if (outcome.state === "resolved") {
              const resolved = resolvedIdsBySession.get(sessionId) ?? new Set<string>()
              resolved.add(permission.id)
              resolvedIdsBySession.set(sessionId, resolved)
            }
            // state: "unknown" → keep the permission in grouped; user can
            // answer manually.
          } catch {
            // Keep failed auto-accept permissions in UI state so the user can act.
          }
        }),
      ))

      for (const sessionId of autoAcceptingSessionIds) {
        const acceptedIds = acceptedIdsBySession.get(sessionId)
        const resolvedIds = resolvedIdsBySession.get(sessionId)
        if (!acceptedIds && !resolvedIds) continue
        const drop = (id: string) =>
          acceptedIds?.has(id) || resolvedIds?.has(id) || false
        const remaining = (grouped[sessionId] ?? []).filter((permission) => !drop(permission.id))
        if (remaining.length > 0) grouped[sessionId] = remaining
        else delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionToastIds,
          show: (title, options) => toast.info(title, options),
          openSession: openSessionFromToast,
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    // Non-fatal: permission resync best-effort
  }
}

async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
  getLiveRevision: (sessionID: string) => number,
  options?: { statusOnly?: boolean },
) {
  const current = store.getState()
  const candidateSessionIds = getActiveSessionCandidateIds(directory, current)

  // Always take an authoritative status snapshot for initialized directories.
  // An empty local candidate set must not skip the fetch — that is exactly how
  // background idle→busy transitions are lost across reconnect.
  await resyncDirectorySessionStatuses(directory, store, candidateSessionIds)

  if (options?.statusOnly) return

  const refreshedCandidateSessionIds = getActiveSessionCandidateIds(directory, store.getState())
  const materializationSessionIds = getReconnectMaterializationSessionIds(refreshedCandidateSessionIds, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
  if (materializationSessionIds.length === 0) return

  const scopedClient = opencodeClient.getScopedSdkClient(directory)
  await Promise.all(materializationSessionIds.map(async (sessionId) => {
    const capturedRevision = getLiveRevision(sessionId)
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const [sessionResponse, messageResponse] = await Promise.all([
      retry(async () => {
        const response = await scopedClient.session.get({ sessionID: sessionId })
        assertSdkSuccess(response, "session.get")
        return response
      }).catch(() => null),
      retry(async () => {
        const response = await scopedClient.session.messages({ sessionID: sessionId, limit: RECONNECT_MESSAGE_LIMIT })
        assertSdkSuccess(response, "session.messages")
        return response
      }).catch(() => null),
    ])
    const session = sessionResponse?.data
    const records = messageResponse?.data
    if (!session || !records) return
    if (!isLiveRevisionCurrent(capturedRevision, getLiveRevision(sessionId))) return
    const cursor = messageResponse.response?.headers?.get?.("x-next-cursor") ?? undefined
    setSessionPrefetch({
      directory,
      sessionID: sessionId,
      limit: records.length,
      cursor,
      complete: !cursor,
    })

    const nextSession = stripSessionDiffSnapshots(session)
    const nextMessages = records
      .filter((record) => !!record?.info?.id)
      .map((record) => stripMessageDiffSnapshots(record.info))
      .sort((a, b) => cmp(a.id, b.id))

    store.setState((state: DirectoryStore) => {
      const sessionIndex = state.session.findIndex((item) => item.id === nextSession.id)
      let sessions = state.session
      let sessionChanged = false
      let sessionTotal = state.sessionTotal

      if (sessionIndex >= 0) {
        if (!haveEquivalentSyncSnapshots(sessions[sessionIndex], nextSession)) {
          sessions = [...state.session]
          sessions[sessionIndex] = nextSession
          sessionChanged = true
        }
      } else {
        sessions = [...state.session]
        sessions.push(nextSession)
        sessions.sort((a, b) => cmp(a.id, b.id))
        if (!nextSession.parentID) sessionTotal += 1
        sessionChanged = true
      }

      const materialized = materializeSessionSnapshots(
        state,
        sessionId,
        records.map((record) => ({
          info: stripMessageDiffSnapshots(record.info),
          parts: record.parts ?? [],
        })),
        { skipPartTypes: RECONNECT_SKIP_PARTS, mode: "recovery" },
      )
      const messagesChanged = materialized.messagesChanged
      const partsChanged = materialized.partsChanged
      if (!sessionChanged && !messagesChanged && !partsChanged) {
        return state
      }

      return {
        ...(sessionChanged ? { session: sessions, sessionTotal } : {}),
        ...(messagesChanged ? { message: materialized.message } : {}),
        ...(partsChanged ? { part: materialized.part } : {}),
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, nextMessages)
  }))

  await resyncBlockingRequestsForDirectory(directory, store, candidateSessionIds)

  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

function handleEvent(
  rawDirectory: string,
  payload: Event,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
) {
  if ((payload as { type?: unknown }).type === "openchamber:worktree-bootstrap-status") {
    const properties = (payload as unknown as { properties?: unknown }).properties
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const record = properties as Record<string, unknown>
      const directory = typeof record.directory === "string" ? record.directory : ""
      if (directory) {
        applyWorktreeBootstrapStatusEvent(directory, {
          status: record.status as "pending" | "ready" | "failed",
          error: typeof record.error === "string" ? record.error : null,
          updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
        })
      }
    }
    return
  }

  if ((payload as { type?: unknown }).type === "openchamber:permission-auto-accept.updated") {
    const properties = (payload as unknown as { properties?: unknown }).properties
    if (properties && typeof properties === "object") {
      const snapshot = properties as { sessions?: unknown }
      if (snapshot.sessions && typeof snapshot.sessions === "object") {
        usePermissionStore.getState().applySnapshot({
          sessions: snapshot.sessions as Record<string, boolean>,
        })
      }
    }
    return
  }

  const directory = resolveDirectoryFromRoutingIndex(routingIndex, rawDirectory, payload, childStores)

  if (handleUiNotificationEvent(payload, directory)) {
    return
  }

  applySessionEventToGlobalSessions(payload, directory)
  // Keep the cross-project status map current for ALL directories (mirrors the
  // global-session handling above). Child stores remain the primary source for
  // synced directories; this map covers sessions a child store doesn't list
  // (unopened directories, or list/status races for just-created sessions).
  applyGlobalSessionStatusEvent(directory, payload)

  // Global events
  if (directory === "global" || !directory) {
    const recent = isRecentBoot()
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      // Suppress refresh during/shortly after bootstrap
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    // On server.connected / global.disposed, re-bootstrap all directories
    // but only if not during recent boot
    if (payload.type === "server.connected" || payload.type === "global.disposed") {
      if (!recent) {
        for (const dir of childStores.children.keys()) {
          const store = childStores.getChild(dir)
          if (store && store.getState().status !== "loading") {
            // Mark as loading to trigger re-bootstrap
            store.setState({ status: "loading" as const, session_status_snapshot_at: undefined })
            childStores.ensureChild(dir)
          }
        }
      }
    }
    return
  }

  // Directory events
  let store = childStores.getChild(directory)
  let resolvedDirectory = directory

  if (!store) {
    // Store not found for this directory — attempt recovery by scanning
    // child stores for the session. This handles directory mismatches
    // (trailing slashes, case differences, events with wrong directory).
    const sessionID = getSessionIdFromPayload(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (!store) {
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    return
  }

  childStores.mark(resolvedDirectory)

  if (payload.type === "permission.asked") {
    const permission = payload.properties as PermissionRequest
    const permissionStore = usePermissionStore.getState()
    if (permissionStore.isSessionAutoAccepting(permission.sessionID)) {
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      if (isVSCodeRuntime()) {
        void sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)
      }
      return
    }

    const session = store.getState().session.find((candidate) => candidate.id === permission.sessionID)
      ?? useGlobalSessionsStore.getState().activeSessions.find((candidate) => candidate.id === permission.sessionID)
    if (session && !(session as Session & { parentID?: string | null }).parentID) {
      const isViewed = isViewedInCurrentSession(resolvedDirectory, permission.sessionID)
      showPermissionNeededToast({
        permission,
        directory: resolvedDirectory,
        isViewed,
        pendingIds: pendingPermissionToastIds,
        show: (title, options) => toast.info(title, options),
        openSession: openSessionFromToast,
      })
    }
  }

  if (payload.type === "permission.replied") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getPermissionToastKey(props.sessionID, props.requestID)
    if (toastKey) {
      pendingPermissionToastIds.delete(toastKey)
      toast.dismiss(`permission-${toastKey}`)
    }
  }

  if (payload.type === "question.asked") {
    const question = payload.properties as QuestionRequest
    const sessionID = question.sessionID
    const session = store.getState().session.find((candidate) => candidate.id === sessionID)
      ?? useGlobalSessionsStore.getState().activeSessions.find((candidate) => candidate.id === sessionID)
    if (session && !(session as Session & { parentID?: string | null }).parentID) {
      const toastKey = getQuestionToastKey(sessionID, question.id)
      const isViewed = isViewedInCurrentSession(resolvedDirectory, sessionID)
      if (!isViewed && toastKey && !pendingQuestionToastIds.has(toastKey)) {
        pendingQuestionToastIds.add(toastKey)
        const firstQuestion = question.questions?.[0]
        const title = firstQuestion?.header?.trim() || "Input needed"
        const description = firstQuestion?.question?.trim() || "Agent is waiting for your response"
        toast.info(title, {
          id: `question-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(sessionID, resolvedDirectory),
          },
        })
      }
    }
  }

  if (payload.type === "question.replied" || payload.type === "question.rejected") {
    const props = payload.properties as { sessionID?: string; requestID?: string }
    const toastKey = getQuestionToastKey(props.sessionID, props.requestID)
    if (toastKey) {
      pendingQuestionToastIds.delete(toastKey)
      toast.dismiss(`question-${toastKey}`)
    }
  }

  // Notification dispatch for top-level session turn-complete events.
  // These are NOT handled by the event reducer — only the notification store.
  if (payload.type === "session.idle") {
    const props = payload.properties as { sessionID?: string }
    const sessionID = props.sessionID
    const storeState = store.getState()
    const session = storeState.session.find((candidate) => candidate.id === sessionID)
      ?? useGlobalSessionsStore.getState().activeSessions.find((candidate) => candidate.id === sessionID)
    if (sessionID && session && !(session as Session & { parentID?: string | null }).parentID) {
      appendNotification({
        directory: resolvedDirectory,
        session: sessionID,
        time: Date.now(),
        viewed: isViewedInCurrentSession(resolvedDirectory, sessionID),
        type: "turn-complete",
      })
    }
  }

  // Sync-layer parent resync: when a child session goes idle, recover
  // the parent session snapshot. This ensures the
  // parent's task tool part reflects the child's completion even when
  // no ToolPart component is mounted.
  if (payload.type === "session.idle") {
    const idleSessionId = getSessionIdFromPayload(payload)
    if (idleSessionId && resolvedDirectory && resolvedDirectory !== "global") {
      const sessionState = store.getState()
      const idleSession = sessionState.session.find((s) => s.id === idleSessionId)
      const parentID = idleSession
        ? (idleSession as Session & { parentID?: string | null }).parentID
        : null
      if (parentID) {
        enqueueSessionMaterialization(resolvedDirectory, parentID, childStores, { reason: "child-session-idle" })
      }
    }
  }

  // Read live state, create targeted draft cloning ONLY fields that event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = store.getState()
  const eventSessionID = getSessionIdFromPayload(payload) ?? undefined
  const eventMessageID = getMessageIdFromPayload(payload) ?? undefined
  if (payload.type === "session.created") {
    const createdSession = (payload.properties as { info?: { id?: string; title?: string } }).info
    sessionActions.trackForkCopySessionCreated(resolvedDirectory, createdSession)
  }
  if (
    (payload.type === "message.updated"
      || payload.type === "message.removed"
      || payload.type === "message.part.updated"
      || payload.type === "message.part.removed"
      || payload.type === "message.part.delta")
    && sessionActions.shouldSuppressForkCopyEvent(resolvedDirectory, eventSessionID, eventMessageID)
  ) {
    return
  }
  const draft: State = { ...current }

  switch (payload.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      draft.session = [...current.session]
      draft.session_status_observed_at = { ...current.session_status_observed_at }
      draft.permission = { ...current.permission }
      draft.todo = { ...current.todo }
      draft.part = { ...current.part }
      break
    case "session.diff":
      draft.session_diff = { ...current.session_diff }
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      draft.session_status = { ...(current.session_status ?? {}) }
      draft.session_status_observed_at = { ...current.session_status_observed_at }
      break
    case "todo.updated":
      draft.todo = { ...current.todo }
      break
    case "message.updated":
      draft.message = { ...current.message }
      draft.part = { ...current.part }
      break
    case "message.removed":
      draft.message = { ...current.message }
      draft.part = { ...current.part }
      break
    case "message.part.updated":
    case "message.part.removed":
    case "message.part.delta":
      draft.part = { ...current.part }
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      draft.permission = { ...current.permission }
      break
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      draft.question = { ...current.question }
      break
    case "lsp.updated":
      draft.lsp = [...current.lsp]
      break
    default:
      break
  }

  const reducerResult = applyDirectoryEvent(draft, payload, {
    onSetSessionTodo: (sessionID, todos) => {
      useTodosPersistStore.getState().setSessionTodos(sessionID, todos)
    },
    now: Date.now,
  })
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization

  if (reducerChanged) {
    store.setState(draft)
    const sessionID = getSessionIdFromPayload(payload) ?? undefined
    const messageID = getMessageIdFromPayload(payload) ?? undefined
    syncDebug.dispatch.eventApplied(payload.type, sessionID, messageID)

  } else {
    const sessionID = getSessionIdFromPayload(payload) ?? undefined
    const messageID = getMessageIdFromPayload(payload) ?? undefined
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

  // Snapshot materialization is driven by typed reducer outcomes, not by
  // inferring meaning from a generic false/no-change result.
  if (materializationResult) {
    const materializationSessionID = resolveMaterializationSessionID(
      materializationResult.sessionID ?? getSessionIdFromPayload(payload) ?? undefined,
      materializationResult.messageID ?? getMessageIdFromPayload(payload) ?? undefined,
      resolvedDirectory,
      routingIndex,
    )
    if (materializationSessionID) {
      enqueueSessionMaterialization(resolvedDirectory, materializationSessionID, childStores, {
        reason: materializationResult.reason,
        messageID: materializationResult.messageID,
        partID: materializationResult.partID,
      })
    }
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

let bundledOpenCodeRuntimeCache: { runtimeKey: string; promise: Promise<boolean> } | null = null

const isBundledOpenCodeRuntime = async () => {
  const runtimeKey = getRuntimeKey()
  if (!bundledOpenCodeRuntimeCache || bundledOpenCodeRuntimeCache.runtimeKey !== runtimeKey) {
    bundledOpenCodeRuntimeCache = {
      runtimeKey,
      promise: runtimeFetch("/api/config/opencode-resolution", { signal: AbortSignal.timeout(4000) })
        .then(async (response) => {
          if (response.ok) {
            const resolution = await response.json() as { source?: unknown; detectedSourceNow?: unknown }
            return resolution.source === "bundled" || resolution.detectedSourceNow === "bundled"
          }

          const healthResponse = await runtimeFetch("/health", { signal: AbortSignal.timeout(4000) })
          if (!healthResponse.ok) return false
          const health = await healthResponse.json() as { opencodeBinarySource?: unknown }
          return health.opencodeBinarySource === "bundled"
        })
        .catch(() => false),
    }
  }
  return bundledOpenCodeRuntimeCache.promise
}

const dispatchOpenCodeUpdateAvailableUnlessBundled = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  void isBundledOpenCodeRuntime().then((isBundled) => {
    if (!isBundled) {
      dispatchOpenCodeUpdateAvailable(payload)
    }
  })
}

export function shouldBootstrapDirectory(
  directory: string,
  currentDirectory: string,
  bootstrapCurrentDirectory?: boolean,
): boolean {
  return directory !== currentDirectory || bootstrapCurrentDirectory !== false
}

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  /** Keeps the current directory store live while deferring its full bootstrap. */
  bootstrapDirectory?: boolean
  children: React.ReactNode
}) {
  // Capacitor apps were previously locked to SSE because Android WebSocket
  // upgrades appeared broken. Root cause was server-side: the Android WebView
  // origin (https://localhost, androidScheme 'https') was missing from the
  // packaged-client origin allowlist, so every WS upgrade was rejected with
  // 403. With the origin allowlisted, mobile uses the same transport
  // selection as everywhere else ('auto' falls back to SSE on WS failure).
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const lastStreamActivityAtRef = useRef(0)
  const lastDomainActivityAtBySessionRef = useRef(new Map<string, number>())
  const liveRevisionBySessionRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)
  const bootstrapGateRef = useRef({ directory: props.directory, enabled: props.bootstrapDirectory })
  bootstrapGateRef.current = { directory: props.directory, enabled: props.bootstrapDirectory }

  const canBootstrapDirectory = (directory: string) => {
    const gate = bootstrapGateRef.current
    return shouldBootstrapDirectory(directory, gate.directory, gate.enabled)
  }

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      sdk: props.sdk,
      directory: props.directory,
    }),
    [childStores, props.sdk, props.directory],
  )

  const triggerDirectoryResync = useCallback((
    directory: string,
    reason: SessionMaterializationReason,
    options?: { statusOnly?: boolean },
  ) => {
    if (!canBootstrapDirectory(directory)) return
    const store = childStores.children.get(directory)
    if (!store) return
    const resyncing = resyncingDirectoriesRef.current
    if (resyncing.has(directory)) return

    console.warn("[refresh-debug] directory-resync", { directory, reason, statusOnly: !!options?.statusOnly })

    // status-only snapshots should not start the full-resync cooldown; they only
    // refresh busy/idle truth after stream ready / recent boot.
    if (!options?.statusOnly) {
      lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    }
    resyncing.add(directory)
    void resyncDirectoryAfterReconnect(
      directory,
      store,
      routingIndex,
      reason,
      (sessionID) => (
        liveRevisionBySessionRef.current.get(viewedSessionKey(directory, sessionID)) ?? 0
      ),
      options,
    )
      .catch(() => {
        // Transient failure — the watchdog, next stream event, or reconnect will catch up.
      })
      .finally(() => {
        resyncing.delete(directory)
      })
  }, [childStores, routingIndex])

  // Configure child store manager
  useEffect(() => {
    if (isVSCodeRuntime()) return
    void usePermissionStore.getState().hydrate().catch(() => undefined)
  }, [props.sdk])

  useEffect(() => {
    const bootingDirs = new Set<string>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (!canBootstrapDirectory(directory)) return
        if (bootingDirs.has(directory)) return
        bootingDirs.add(directory)

        const store = childStores.getChild(directory)
        if (!store) return

        const runBootstrap = async () => {
          await waitForSessionStartupBarrier()
          if (!canBootstrapDirectory(directory)) return
          const globalState = useGlobalSyncStore.getState()
          await bootstrapDirectory({
            directory,
            sdk: props.sdk,
            getState: () => store.getState(),
            set: (patch) => {
              store.setState(patch)
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            global: {
              config: globalState.config,
              projects: globalState.projects,
            },
          })
        }

        runBootstrap().finally(() => {
          bootingDirs.delete(directory)
        })
      },
      onDispose: (directory) => {
        bootingDirs.delete(directory)
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
  }, [childStores, props.sdk, routingIndex])

  // Bootstrap global state — set bootingRoot/bootedAt to suppress
  // redundant refresh events during startup
  useEffect(() => {
    const generation = ++globalBootstrapGeneration
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions
    void waitForSessionStartupBarrier().then(() => {
      if (globalBootstrapGeneration !== generation) return undefined
      return bootstrapGlobal(props.sdk, (patch) => {
      if (globalBootstrapGeneration === generation) {
        globalActions.set(patch)
      }
      })
    })
      .then(() => {
        if (globalBootstrapGeneration === generation) {
          bootedAt = Date.now()
        }
      })
      .finally(() => {
        if (globalBootstrapGeneration === generation) {
          bootingRoot = false
        }
      })
    return () => {
      if (globalBootstrapGeneration === generation) {
        bootingRoot = false
      }
    }
  }, [props.sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const pipeline = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onEvent: (directory, payload) => {
        const sessionID = resolveStrictDomainSessionID(payload, routingIndex.messageSessionById) ?? null
        if (sessionID && isSnapshotRevisionEvent(payload)) {
          const revisionKey = viewedSessionKey(directory, sessionID)
          liveRevisionBySessionRef.current.set(revisionKey, (liveRevisionBySessionRef.current.get(revisionKey) ?? 0) + 1)
        }
        if (
          sessionID
          && directory === _activeDirectory
          && sessionID === _activeSession
          && (payload.type === "message.updated"
            || payload.type === "message.removed"
            || payload.type === "message.part.updated"
            || payload.type === "message.part.removed"
            || payload.type === "message.part.delta")
        ) {
          lastDomainActivityAtBySessionRef.current.set(viewedSessionKey(directory, sessionID), Date.now())
        }
        if (sessionID && directory === _activeDirectory && sessionID === _activeSession && payload.type === "session.status") {
          const status = (payload.properties as { status?: SessionStatus }).status
          if (status?.type === "busy" || status?.type === "retry") {
            const key = viewedSessionKey(directory, sessionID)
            if (!lastDomainActivityAtBySessionRef.current.has(key)) {
              lastDomainActivityAtBySessionRef.current.set(key, Date.now())
            }
          }
          if (status?.type === "idle") {
            lastDomainActivityAtBySessionRef.current.delete(viewedSessionKey(directory, sessionID))
          }
        }
        if (sessionID && (payload.type === "session.idle" || payload.type === "session.deleted")) {
          lastDomainActivityAtBySessionRef.current.delete(viewedSessionKey(directory, sessionID))
        }
        dispatchVSCodeRuntimeNotificationEvent(directory, payload)
        if (payload.type === "installation.update-available") {
          const version = typeof (payload.properties as { version?: unknown })?.version === "string"
            ? (payload.properties as { version: string }).version
            : ""
          if (version) {
            dispatchOpenCodeUpdateAvailableUnlessBundled({ version })
          }
        }
        handleEvent(directory, payload, childStores, routingIndex)
      },
      onTransportActivity: () => {
        lastStreamActivityAtRef.current = Date.now()
      },
      onReconnect: () => {
        console.warn("[refresh-debug] stream-reconnect", {
          connectedBefore: pipelineHasConnectedRef.current,
          disconnectedBeforeFirstConnect: pipelineDisconnectedBeforeFirstConnectRef.current,
        })
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        const isFirstConnect = !pipelineHasConnectedRef.current
        pipelineHasConnectedRef.current = true
        // Always close the bootstrap-GET → WS-ready gap with an authoritative
        // status snapshot. Skip heavier message materialization on first ready
        // / recent boot; those paths already have bootstrap coverage.
        const statusOnly = (
          (isFirstConnect && !pipelineDisconnectedBeforeFirstConnectRef.current)
          || isRecentBoot()
        )
        for (const dir of childStores.children.keys()) {
          triggerDirectoryResync(dir, "stream-reconnect", { statusOnly })
        }
      },
      onDisconnect: (reason) => {
        console.warn("[refresh-debug] stream-disconnect", { reason })
        if (!pipelineHasConnectedRef.current) {
          pipelineDisconnectedBeforeFirstConnectRef.current = true
        }
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
          lastDisconnectReason: reason,
        })
      },
      onTransportSwitch: () => {
        console.warn("[refresh-debug] stream-transport-switch")
        // Transport changes are gap-prone in real networks. Treat them like a
        // reconnect and refresh active session snapshots from HTTP.
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
        })
        for (const dir of childStores.children.keys()) {
          triggerDirectoryResync(dir, "transport-switch")
        }
      },
    })
    pipelineReconnectRef.current = pipeline.reconnect
    return () => {
      if (pipelineReconnectRef.current === pipeline.reconnect) {
        pipelineReconnectRef.current = null
      }
      pipeline.cleanup()
    }
  }, [props.sdk, childStores, routingIndex, messageStreamTransport, triggerDirectoryResync])

  useEffect(() => {
    let stopped = false
    let running = false

    // Transport/domain watchdog only — live busy/idle comes from the global
    // event WS. One-shot `/session/status` snapshots are reserved for bootstrap
    // and reconnect/escalated resyncs, not a periodic poll.
    const tick = () => {
      if (running || stopped) return
      running = true
      void Promise.resolve()
        .then(() => {
          if (stopped) return
          const now = Date.now()
          for (const [directory, store] of childStores.children.entries()) {
            const state = store.getState()
            const candidateSessionIds = getStatusWatchdogCandidateSessionIds(state)
            if (candidateSessionIds.length === 0) {
              lastFullResyncAtByDirectoryRef.current.delete(directory)
              continue
            }

            const lastFullResyncAt = lastFullResyncAtByDirectoryRef.current.get(directory) ?? 0
            if (shouldTriggerStaleResync(lastStreamActivityAtRef.current, lastFullResyncAt, now)) {
              pipelineReconnectRef.current?.("active_stream_stale")
              triggerDirectoryResync(directory, "stale-status-resync")
            }

            const viewed = getViewedSessionMaterializationTarget(directory)
            if (!viewed) continue
            const viewedStatus = state.session_status?.[viewed.sessionId]
            const domainKey = viewedSessionKey(directory, viewed.sessionId)
            const lastDomainActivityAt = lastDomainActivityAtBySessionRef.current.get(domainKey)
            if ((viewedStatus?.type === "busy" || viewedStatus?.type === "retry") && !lastDomainActivityAt) {
              lastDomainActivityAtBySessionRef.current.set(domainKey, now)
              continue
            }
            if (viewedStatus?.type === "idle" || !viewedStatus) {
              lastDomainActivityAtBySessionRef.current.delete(domainKey)
              continue
            }
            if (shouldTriggerDomainRecovery({
              isViewed: true,
              status: viewedStatus,
              lastTransportActivityAt: lastStreamActivityAtRef.current,
              lastDomainActivityAt: lastDomainActivityAt ?? 0,
              lastFullResyncAt,
              now,
            })) {
              triggerDirectoryResync(directory, "domain-stale-resync")
            }

          }
        })
        .finally(() => {
          running = false
        })
    }

    const interval = setInterval(tick, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS)
    tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [childStores, triggerDirectoryResync])

  // Ensure current directory's child store exists
  useEffect(() => {
    let seedExpiryTimer: ReturnType<typeof setTimeout> | undefined
    if (props.directory) {
      const store = childStores.ensureChild(props.directory, {
        bootstrap: shouldBootstrapDirectory(props.directory, props.directory, props.bootstrapDirectory),
      })
      const statusSeed = getRuntimeLiveStatusSeed(getRuntimeKey(), props.directory)
      if (statusSeed) {
        store.setState((state: DirectoryStore) => ({
          session_status: {
            ...state.session_status,
            [statusSeed.sessionId]: state.session_status[statusSeed.sessionId] ?? statusSeed.status,
          },
        }))
        seedExpiryTimer = setTimeout(() => {
          store.setState((state: DirectoryStore) => {
            if (state.session_status[statusSeed.sessionId] !== statusSeed.status) {
              return state
            }
            return {
              session_status: {
                ...state.session_status,
                [statusSeed.sessionId]: { type: "idle" as const },
              },
            }
          })
        }, LIVE_STATUS_TTL_MS)
      }
      ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    }
    return () => {
      if (seedExpiryTimer) clearTimeout(seedExpiryTimer)
    }
  }, [props.directory, props.bootstrapDirectory, childStores, routingIndex])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      props.sdk,
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
    )
  }, [props.sdk, props.directory, childStores, routingIndex])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    updateStreamingState(store.getState())
    const unsubscribe = store.subscribe((state) => {
      updateStreamingState(state)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Get the child store for a directory (defaults to current).
 *
 * Pass `{ bootstrap: false }` when you only need the store reference for an
 * on-demand `getState()` (not live subscription) and must NOT trigger a full
 * directory bootstrap. This avoids storms of pointless session-list fetches +
 * empty-retry loops for directories that are merely referenced by sidebar rows
 * (e.g. archived sessions on deleted worktrees).
 */
export function useDirectoryStore(
  directory?: string,
  options?: { bootstrap?: boolean },
): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  return system.childStores.ensureChild(dir, options)
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** React wiring for exact requested directory status subscriptions. */
export function useScopedSessionStatusRevision(scopes: ScopedSessionStatusScope[]): string {
  const { childStores } = useSyncSystem()
  const scopeKey = scopes.map((scope) => `${scope.directory}\n${scope.sessionID}`).join("\u0000")
  const scopesRef = useRef(scopes)
  scopesRef.current = scopes
  const subscribe = useCallback((notify: () => void) => {
    if (!scopeKey) return () => undefined
    return subscribeScopedSessionStatuses(childStores, scopesRef.current, notify)
  }, [childStores, scopeKey])
  const getSnapshot = useCallback(() => scopeKey ? scopedSessionStatusSignature(childStores, scopesRef.current) : "", [childStores, scopeKey])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useScopedSessionStatusReader(): (scope: ScopedSessionStatusScope) => ScopedSessionStatus {
  const { childStores } = useSyncSystem()
  return useCallback((scope) => readScopedSessionStatus(childStores, scope), [childStores])
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_MESSAGES
    return store.getState().message[sessionID] ?? EMPTY_MESSAGES
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Check whether the message list for a session has been loaded into sync state. */
export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

/** Subscribe to the standard session materialization lifecycle for one scoped transcript. */
export function useSessionMessageLoadState(sessionID: string, directory?: string): SessionPrefetchMeta | undefined {
  const system = useSyncSystem()
  const targetDirectory = directory ?? system.directory
  const runtimeKey = getRuntimeKey()
  const subscribe = useCallback(
    (notify: () => void) => sessionID ? subscribeSessionPrefetch(targetDirectory, sessionID, notify, runtimeKey) : () => undefined,
    [runtimeKey, sessionID, targetDirectory],
  )
  const getSnapshot = useCallback(
    () => sessionID ? getSessionPrefetch(targetDirectory, sessionID, runtimeKey) : undefined,
    [runtimeKey, sessionID, targetDirectory],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get parts for a specific message */
export function useSessionParts(messageID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.part[messageID] ?? EMPTY_PARTS, [messageID]),
    directory,
  )
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return undefined
    return store.getState().session_status?.[sessionID]
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionStatusObservedAt(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return undefined
    return store.getState().session_status_observed_at?.[sessionID]
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionStatusSnapshotAt(directory?: string, enabled = true) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(
    () => enabled ? store.getState().session_status_snapshot_at : undefined,
    [enabled, store],
  )
  const subscribe = useCallback(
    (notify: () => void) => enabled ? store.subscribe(notify) : () => undefined,
    [enabled, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get permissions for a specific session */
export function useSessionPermissions(
  sessionID: string,
  directory?: string,
  options?: { bootstrap?: boolean },
) {
  const store = useDirectoryStore(directory, options)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_PERMISSION_REQUESTS
    return store.getState().permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get questions for a specific session */
export function useSessionQuestions(
  sessionID: string,
  directory?: string,
  options?: { bootstrap?: boolean },
) {
  // Mirror useSessionPermissions so lightweight consumers (sidebar rows) can
  // subscribe with `{ bootstrap: false }` and still receive routed
  // question.asked / replied / rejected events without kicking off a full
  // directory bootstrap.
  const store = useDirectoryStore(directory, options)
  return useStore(
    store,
    useCallback(
      (state: State) => (sessionID ? (state.question[sessionID] ?? EMPTY_QUESTION_REQUESTS) : EMPTY_QUESTION_REQUESTS),
      [sessionID],
    ),
  )
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const selectPermissionRequestsBySession = (state: State) => state.permission
const selectQuestionRequestsBySession = (state: State) => state.question

type ScopedBlockingRequestCache<T extends { id: string }> = {
  sessionID: string | null
  sessions: Session[] | null
  requestsBySession: Record<string, T[] | undefined> | null
  result: T[]
}

function useScopedBlockingRequests<T extends { id: string }>(
  sessionID: string | null,
  directory: string | undefined,
  selectRequestsBySession: (state: State) => Record<string, T[] | undefined>,
  empty: T[],
): T[] {
  const cacheRef = useRef<ScopedBlockingRequestCache<T>>({
    sessionID: null,
    sessions: null,
    requestsBySession: null,
    result: empty,
  })

  return useDirectorySync(
    useCallback((state: State) => {
      const requestsBySession = selectRequestsBySession(state)
      const cache = cacheRef.current
      if (
        cache.sessionID === sessionID
        && cache.sessions === state.session
        && cache.requestsBySession === requestsBySession
      ) {
        return cache.result
      }

      const next = collectScopedBlockingRequests(state.session, requestsBySession, sessionID, empty)
      const result = areRequestArraysReferentiallyEqual(cache.result, next) ? cache.result : next
      cacheRef.current = {
        sessionID,
        sessions: state.session,
        requestsBySession,
        result,
      }
      return result
    }, [empty, selectRequestsBySession, sessionID]),
    directory,
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingQuestions(sessionID: string | null, directory?: string): QuestionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectQuestionRequestsBySession, EMPTY_QUESTION_REQUESTS)
}

export function useParentSessionTarget(sessionID: string | null, directory?: string) {
  const directoryCurrent = useSession(sessionID, directory)
  const liveCurrent = useSession(sessionID)
  const globalCurrent = useGlobalSessionsStore(useCallback((state) => (
    state.activeSessions.find((session) => session.id === sessionID)
      ?? state.archivedSessions.find((session) => session.id === sessionID)
      ?? null
  ), [sessionID]))
  const current = directoryCurrent ?? liveCurrent ?? globalCurrent
  const parentID = current?.parentID ?? null

  const directoryParent = useSession(parentID, directory)
  const liveParent = useSession(parentID)
  const globalParent = useGlobalSessionsStore(useCallback((state) => (
    state.activeSessions.find((session) => session.id === parentID)
      ?? state.archivedSessions.find((session) => session.id === parentID)
      ?? null
  ), [parentID]))

  const parent = directoryParent ?? liveParent ?? globalParent
  return resolveParentSessionTarget(sessionID, current, parent, directory)
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return childStores.getChild(directory)?.getState().session.find((session) => session.id === sessionID)
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory).subscribe(notify)
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useCurrentSessionEntity(sessionID?: string | null): Session | null {
  const liveSession = useSession(sessionID)
  const globalActiveSession = useGlobalSessionsStore(useCallback((state) => {
    if (!sessionID) return null
    return state.activeSessions.find((session) => session.id === sessionID) ?? null
  }, [sessionID]))
  const resolvedSession = resolveCurrentSessionEntity(sessionID, liveSession, globalActiveSession)
  const lastResolvedSessionRef = useRef<{
    sessionID: string
    session: Session
    expiresAt: number | null
  } | null>(null)
  const [, setFallbackVersion] = React.useState(0)

  useEffect(() => {
    if (!sessionID) {
      lastResolvedSessionRef.current = null
      return
    }

    if (resolvedSession) {
      lastResolvedSessionRef.current = {
        sessionID,
        session: resolvedSession,
        expiresAt: null,
      }
      return
    }

    const cached = lastResolvedSessionRef.current
    if (!cached || cached.sessionID !== sessionID) {
      lastResolvedSessionRef.current = null
      return
    }

    const expiresAt = cached.expiresAt ?? Date.now() + CURRENT_SESSION_ENTITY_CACHE_TTL_MS
    cached.expiresAt = expiresAt
    const remainingMs = expiresAt - Date.now()

    const timeoutID = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionID === sessionID) {
        lastResolvedSessionRef.current = null
      }
      setFallbackVersion((value) => value + 1)
    }, remainingMs)

    return () => window.clearTimeout(timeoutID)
  }, [resolvedSession, sessionID])

  if (resolvedSession) return resolvedSession
  const cached = lastResolvedSessionRef.current
  if (cached && cached.sessionID === sessionID && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return cached.session
  }
  return null
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  const session = useSession(sessionID, directory)
  return (session as (typeof session & { directory?: string | null }) | undefined)?.directory ?? undefined
}

/** Get the SDK client */
export function useSyncSDK() {
  return useSyncSystem().sdk
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncSystem().childStores
}

export type SessionTextMessage = {
  id: string
  role: string | null
  text: string
}

const getPartText = (part: Part): string => {
  if (part?.type !== "text") return ""
  const text = (part as { text?: unknown }).text
  return typeof text === "string" ? text : ""
}

const getConcatenatedTextFromParts = (parts: Part[]): string => {
  let text = ""
  for (const part of parts) {
    text += getPartText(part)
  }
  return text
}

type SessionMessageRecord = { info: Message; parts: Part[] }
const EMPTY_SESSION_MESSAGE_RECORDS: SessionMessageRecord[] = []

type SessionMessageRecordsSnapshot = {
  sessionID: string
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
  suspendPartUpdates: boolean
  suspendedPartUpdatesMessageID?: string
  list: SessionMessageRecord[]
  byId: Map<string, SessionMessageRecord>
}

const SESSION_MESSAGE_RECORDS_CACHE_MAX = 40
const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4
const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30
const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4
const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30
const sessionMessageRecordsCache = new WeakMap<StoreApi<DirectoryStore>, Map<string, SessionMessageRecordsSnapshot>>()

const getSessionMessageRecordsCacheKey = (
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): string => (
  `${sessionID}\u0000${suspendPartUpdates ? 1 : 0}\u0000${suspendedPartUpdatesMessageID ?? ""}`
)

const getSessionMessageRecordsCache = (store: StoreApi<DirectoryStore>): Map<string, SessionMessageRecordsSnapshot> => {
  let cache = sessionMessageRecordsCache.get(store)
  if (!cache) {
    cache = new Map()
    sessionMessageRecordsCache.set(store, cache)
  }
  return cache
}

const readCachedSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return undefined
  const key = getSessionMessageRecordsCacheKey(sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  const cached = cache.get(key)
  if (!cached) return undefined
  cache.delete(key)
  cache.set(key, cached)
  return cached
}

const rememberSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  snapshot: SessionMessageRecordsSnapshot,
): void => {
  if (!snapshot.sessionID) return
  const cache = getSessionMessageRecordsCache(store)
  const key = getSessionMessageRecordsCacheKey(
    snapshot.sessionID,
    snapshot.suspendPartUpdates,
    snapshot.suspendedPartUpdatesMessageID,
  )
  const constrainedMaxMessages = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
      : null
  if (constrainedMaxMessages !== null && snapshot.list.length > constrainedMaxMessages) {
    cache.delete(key)
    return
  }
  cache.delete(key)
  cache.set(key, snapshot)
  const max = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX
      : SESSION_MESSAGE_RECORDS_CACHE_MAX
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

export function dropCachedSessionMessageRecordsSnapshots(
  store: StoreApi<DirectoryStore>,
  sessionIDs: Iterable<string>,
): void {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const prefix = `${sessionID}\u0000`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key)
      }
    }
  }
}

// Shell-mode bridge messages (single bash tool part parented to a synthetic
// shell-marker user message) are hidden from the timeline and rendered inside
// the user row, so they never go through the live streaming-tail path. Their
// part updates (output chunks, running→completed) must not be suspended, or
// the shell card freezes until the next full snapshot rebuild.
const USER_SHELL_MARKER = "The following tool was executed by the user"

const isSuspendExemptShellBridge = (state: State, info: Message, parts: Part[] | undefined): boolean => {
  if (!parts || parts.length !== 1) return false
  const part = parts[0] as { type?: unknown; tool?: unknown }
  if (part?.type !== "tool" || typeof part.tool !== "string" || part.tool.toLowerCase() !== "bash") return false
  const parentID = (info as { parentID?: unknown }).parentID
  if (typeof parentID !== "string" || parentID.length === 0) return false
  const parentParts = state.part[parentID]
  if (!parentParts) return false
  return parentParts.some((parentPart) => {
    if (parentPart?.type !== "text") return false
    if ((parentPart as { synthetic?: boolean }).synthetic !== true) return false
    const text = (parentPart as { text?: unknown }).text
    return typeof text === "string" && text.trim().startsWith(USER_SHELL_MARKER)
  })
}

const snapshotPartsMatchState = (snapshot: SessionMessageRecordsSnapshot, state: State): boolean => {
  for (const record of snapshot.list) {
    if (snapshot.suspendPartUpdates) {
      const suspendedID = snapshot.suspendedPartUpdatesMessageID
      if (
        (!suspendedID || record.info.id === suspendedID)
        && !isSuspendExemptShellBridge(state, record.info, state.part[record.info.id])
      ) {
        continue
      }
    }
    if ((state.part[record.info.id] ?? EMPTY_PARTS) !== record.parts) {
      return false
    }
  }

  return true
}

const getReusableSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  state: State,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cached = readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  if (!cached) return undefined
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
  if (
    cached.sourceMessages === sourceMessages
    && cached.revertMessageID === revertMessageID
    && cached.suspendPartUpdates === suspendPartUpdates
    && cached.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && snapshotPartsMatchState(cached, state)
  ) {
    return cached
  }
  return undefined
}

function getVisibleMessagesForSession(state: State, sessionID: string, previous?: SessionMessageRecordsSnapshot): {
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
} {
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID

  if (
    previous
    && previous.sourceMessages === sourceMessages
    && previous.revertMessageID === revertMessageID
  ) {
    return {
      sourceMessages,
      visibleMessages: previous.visibleMessages,
      revertMessageID,
    }
  }

  return {
    sourceMessages,
    visibleMessages: revertMessageID ? sourceMessages.filter((message) => message.id < revertMessageID) : sourceMessages,
    revertMessageID,
  }
}

export function buildSessionMessageRecordsSnapshot(
  state: State,
  sessionID: string,
  previous?: SessionMessageRecordsSnapshot,
  suspendPartUpdates = false,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const shouldSuspendParts = suspendPartUpdates
      && previousRecord
      && (!suspendedPartUpdatesMessageID || message.id === suspendedPartUpdatesMessageID)
      && !isSuspendExemptShellBridge(state, message, state.part[message.id])
    const parts = shouldSuspendParts
      ? previousRecord.parts
      : (state.part[message.id] ?? EMPTY_PARTS)

    const nextRecord = previousRecord && previousRecord.info === message && previousRecord.parts === parts
      ? previousRecord
      : { info: message, parts }

    nextById.set(message.id, nextRecord)
    return nextRecord
  })

  const unchanged = Boolean(previous)
    && previous?.visibleMessages === visibleMessages
    && previous.suspendPartUpdates === suspendPartUpdates
    && previous.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && previous.list.length === nextList.length
    && previous.list.every((record, index) => record === nextList[index])

  if (unchanged && previous) {
    return previous
  }

  return {
    sessionID,
    sourceMessages,
    visibleMessages,
    revertMessageID,
    suspendPartUpdates,
    suspendedPartUpdatesMessageID,
    list: nextList,
    byId: nextById,
  }
}

export function useSessionMessageCount(sessionID: string, directory?: string): number {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return 0
      return state.message[sessionID]?.length ?? 0
    }, [sessionID]),
    directory,
  )
}

export function useSessionTextMessages(sessionID: string, directory?: string): SessionTextMessage[] {
  const records = useSessionMessageRecords(sessionID, directory)

  return useMemo(
    () => records.map((record) => ({
      id: record.info.id,
      role: typeof record.info.role === "string" ? record.info.role : null,
      text: getConcatenatedTextFromParts(record.parts),
    })),
    [records],
  )
}

export function useUserMessageHistory(sessionID: string, directory?: string): string[] {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<UserMessageHistorySnapshot>(EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT)

  const getSnapshot = useCallback(() => {
    const next = buildUserMessageHistorySnapshot(store.getState(), sessionID, snapshotRef.current)
    snapshotRef.current = next
    return next.history
  }, [sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { suspendPartUpdates?: boolean; suspendPartUpdatesForMessageId?: string | null },
) {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<SessionMessageRecordsSnapshot>({
    sessionID,
    sourceMessages: EMPTY_MESSAGES,
    visibleMessages: EMPTY_MESSAGES,
    revertMessageID: undefined,
    suspendPartUpdates: Boolean(options?.suspendPartUpdates),
    suspendedPartUpdatesMessageID: options?.suspendPartUpdatesForMessageId ?? undefined,
    list: [],
    byId: new Map(),
  })

  const getSnapshot = useCallback(() => {
    if (!sessionID) {
      return EMPTY_SESSION_MESSAGE_RECORDS
    }

    const state = store.getState()
    const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
    const suspendedPartUpdatesMessageID = options?.suspendPartUpdatesForMessageId ?? undefined
    const reusableSnapshot = getReusableSessionMessageRecordsSnapshot(
      store,
      state,
      sessionID,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    if (reusableSnapshot) {
      snapshotRef.current = reusableSnapshot
      return reusableSnapshot.list
    }

    const previousSnapshot = snapshotRef.current.sessionID === sessionID
      ? snapshotRef.current
      : readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)

    const nextSnapshot = buildSessionMessageRecordsSnapshot(
      state,
      sessionID,
      previousSnapshot,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    snapshotRef.current = nextSnapshot
    rememberSessionMessageRecordsSnapshot(store, nextSnapshot)
    return nextSnapshot.list
  }, [options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe(notify)
  }, [sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Ensures a session's messages are loaded into the sync store.
 * If the session exists in state.session but messages haven't been fetched
 * (state.message[sessionID] is absent), triggers a background API fetch.
 *
 * This covers the case where a user navigates to an old parent session
 * whose child session messages were never loaded — bootstrap only loads
 * session metadata, not messages.
 */

// Module-level in-flight tracking for useEnsureSessionMessages.
// Prevents redundant parallel fetches when multiple component instances
// (e.g. multiple ToolParts) request the same session's messages.
const _ensureMessagesLoading = new Set<string>()

export function useEnsureSessionMessages(sessionID: string, directory?: string) {
  const syncDirectory = useSyncDirectory()
  const resolvedDirectory = directory ?? syncDirectory
  const store = useDirectoryStore(resolvedDirectory)
  const requestGenerationRef = React.useRef(0)

  React.useEffect(() => {
    if (!sessionID) return

    const state = store.getState()
    // Already loaded into a renderable message/part snapshot — nothing to do.
    if (getSessionMaterializationStatus(state, sessionID).renderable) return
    // Session doesn't exist — nothing to load
    if (!state.session.some((s) => s.id === sessionID)) return

    const loadingKey = `${resolvedDirectory}:${sessionID}`
    // Already loading this session for this directory
    if (_ensureMessagesLoading.has(loadingKey)) return

    const generation = ++requestGenerationRef.current
    const isStale = () => generation !== requestGenerationRef.current

    _ensureMessagesLoading.add(loadingKey)

    void (async () => {
      try {
        await materializeSessionFromServer(resolvedDirectory, sessionID, store, { reason: "ensure-session-messages", isStale })
      } catch {
        // Transient failure — next navigation or reconnect will retry
      } finally {
        _ensureMessagesLoading.delete(loadingKey)
      }
    })()
  }, [sessionID, store, resolvedDirectory])
}
const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
