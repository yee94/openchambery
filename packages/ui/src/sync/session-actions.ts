/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { OpencodeClient, Session, Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { useSessionUIStore, type ForkTransitionStage, type MessageEditSnapshot } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { opencodeClient } from "@/lib/opencode/client"
import { getSessionActivityUpdatedAt } from "@/lib/sessionActivity"
import { mergeSessionDirectoryMetadata, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { registerSessionDirectory } from "./sync-refs"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { getAllSyncSessionMap } from "./sync-refs"
import { sessionDraftKey, type DraftKey } from "./input-draft-types"
import {
  buildSentMessageComposerRestoration,
  commitComposerRestoration,
  rollbackComposerRestoration,
  type ComposerRestorationPayload,
} from "./message-composer-restoration"
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import { isRelayTransportReady } from "@/lib/relay/runtime-tunnel"
import {
  isStreamActivityStale,
  requestStreamReconnect,
} from "./stream-liveness"
import {
  applyTranscriptCommand,
  ensureTranscriptInitial,
  getTranscriptRepository,
  listCanonicalTranscriptScopes,
  materializeTranscriptMessage,
  resolveTranscriptRepositoryForStore,
  transcriptScope,
} from "./transcript-repository-runtime"
import {
  isSessionAuthorityRevalidateFresh,
  markSessionAuthorityRevalidated,
} from "./session-authority-revalidate"
import type { TranscriptData, TranscriptRepository } from "./transcript-repository"
import { messagesFromTranscriptData } from "./transcript-repository-observers"
import { fetchProductionTranscriptTransportPage } from "./transcript-repository-production"
import { runSessionHistoryMutation } from "./session-history-mutation-coordinator"
import {
  getInitialSessionMessageLimit,
  getMessageRefetchLimit,
  getSendConfirmationRefetchLimit,
} from "./session-message-policy"
import { resolveSessionMergeStrategy, SEND_GAP_FILL_SESSION_MERGE_STRATEGY } from "./session-merge-strategy"

import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"
import { reconcileActiveSessionStatusAfterMessagePull } from "./session-status-reconciliation"
import { seedSessionTodosFromHydratedTranscript } from "./session-todo-projection"
import {
  recordTranscriptDiff,
  tryCaptureTranscriptCanonicalSnapshot,
} from "./transcript-diagnostics-runtime"

const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 2
const SEND_CONFIRMATION_REFETCH_RETRY_MS = 150
const MESSAGE_REFETCH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const UNREVERT_REFETCH_ATTEMPTS = 3
const UNREVERT_REFETCH_RETRY_MS = 150

let activeForkCopy: {
  operationId: number
  runtimeKey: string
  directory: string
  sourceSessionID: string
  expectedTargetTitle: string
  targetSessionID?: string
} | null = null
const forkCopyEventCutoffs = new Map<string, { messageID: string; expiresAt: number }>()
const FORK_COPY_EVENT_CUTOFF_TTL_MS = 30_000

export function trackForkCopySessionCreated(directory: string, session?: { id?: string; title?: string }): void {
  const sessionID = session?.id
  if (
    !activeForkCopy
    || activeForkCopy.runtimeKey !== getRuntimeKey()
    || activeForkCopy.directory !== directory
    || !sessionID
    || session?.title !== activeForkCopy.expectedTargetTitle
    || sessionID === activeForkCopy.sourceSessionID
    || activeForkCopy.targetSessionID
  ) {
    return
  }
  activeForkCopy.targetSessionID = sessionID
}

function getForkedSessionTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (!match) return `${title} (fork #1)`
  return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`
}

/** Advance the full-screen fork Loading label and yield so React can paint. */
async function setForkTransitionStage(
  operationId: number,
  stage: ForkTransitionStage,
): Promise<void> {
  useSessionUIStore.setState((state) =>
    state.forkTransition?.operationId === operationId
      ? { forkTransition: { ...state.forkTransition, stage } }
      : state,
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Bind the forked session id so the loading shell can follow that chat only. */
function setForkTransitionTarget(
  operationId: number,
  targetSessionId: string,
): void {
  useSessionUIStore.setState((state) =>
    state.forkTransition?.operationId === operationId
      ? { forkTransition: { ...state.forkTransition, targetSessionId } }
      : state,
  )
}

function isLiveForkStatus(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry"
}

function lastUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

function isOpenAssistantTail(messages: Message[]): boolean {
  const last = messages.at(-1)
  return last?.role === "assistant" && last.time.completed == null
}

/**
 * Live `/fork` needs a user-turn cutoff. Missing status is not live on its own:
 * `/session/status` omits idle sessions, so a completed tail with no entry is idle.
 */
function needsLiveUserForkPoint(status: SessionStatus | undefined, messages: Message[]): boolean {
  return isLiveForkStatus(status) || (status == null && isOpenAssistantTail(messages))
}

export function resolveForkMessageId(
  messageId: string | undefined,
  messages: Message[],
  status: SessionStatus | undefined,
): string | undefined {
  if (messageId) {
    const messageIndex = messages.findIndex((message) => message.id === messageId)
    if (messageIndex === -1 || messages[messageIndex]?.role !== "assistant") return messageId
    return messages[messageIndex + 1]?.id
  }
  // OpenCode session.fork(messageID) copies strictly before that message.
  // Idle and omitted-idle `/fork` pass undefined so the full history is kept.
  // Busy/retry (or a missing status with an open assistant tail) pass the first
  // message after the latest user so that user turn is included and the
  // in-progress assistant work is not.
  if (!needsLiveUserForkPoint(status, messages)) return undefined
  const userIndex = lastUserMessageIndex(messages)
  if (userIndex === -1) return undefined
  return messages[userIndex + 1]?.id
}

async function markForkSessionAsLatest(session: Session, directory: string): Promise<Session> {
  const metadata = getSessionMetadata(session)
  const openchamber = metadata.openchamber && typeof metadata.openchamber === "object"
    ? metadata.openchamber as Record<string, unknown>
    : {}
  const titleRefresh = openchamber.titleRefresh && typeof openchamber.titleRefresh === "object"
    ? openchamber.titleRefresh as Record<string, unknown>
    : {}

  return opencodeClient.updateSession(session.id, {
    metadata: {
      ...metadata,
      openchamber: {
        ...openchamber,
        titleRefresh: {
          ...titleRefresh,
          activityUpdatedAt: Date.now(),
        },
      },
    },
  }, directory)
}

export function shouldSuppressForkCopyEvent(directory: string, sessionID?: string, messageID?: string): boolean {
  if (
    activeForkCopy
    && activeForkCopy.runtimeKey === getRuntimeKey()
    && activeForkCopy.directory === directory
    && sessionID
    && sessionID === activeForkCopy.targetSessionID
  ) {
    return true
  }
  if (!sessionID || !messageID) return false
  const key = `${getRuntimeKey()}:${directory}:${sessionID}`
  const cutoff = forkCopyEventCutoffs.get(key)
  if (!cutoff) return false
  if (cutoff.expiresAt <= Date.now()) {
    forkCopyEventCutoffs.delete(key)
    return false
  }
  return messageID <= cutoff.messageID
}

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
const PENDING_MESSAGE_FETCHES = new Map<string, { sessionID: string; directory: string }>()
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }
type OptimisticConfirmInput = OptimisticRemoveInput

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null
let _optimisticConfirm: ((input: OptimisticConfirmInput) => void) | null = null

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: { status?: number }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message

    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object") {
      const dataMessage = (data as { message?: unknown }).message
      if (typeof dataMessage === "string" && dataMessage.length > 0) return dataMessage
    }
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
  const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`) as Error & { status?: number }
  if (status !== undefined) error.status = status
  throw error
}

function assertSdkData<T>(result: SdkResult<T>, operation: string): T {
  const data = assertSdkSuccess(result, operation)
  if (data === undefined || data === null) {
    throw new Error(`${operation} failed: empty response`)
  }
  return data
}

export function setActionRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  getDirectory: () => string,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory

  if (PENDING_MESSAGE_FETCHES.size > 0) {
    const pending = [...PENDING_MESSAGE_FETCHES.values()]
    PENDING_MESSAGE_FETCHES.clear()
    queueMicrotask(() => {
      for (const request of pending) {
        void fetchMessagesForSession(request.sessionID, request.directory)
      }
    })
  }
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
  confirm?: (input: OptimisticConfirmInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
  _optimisticConfirm = confirm ?? null
}

/**
 * Queue reconciliation concluded the message never landed. Drop the preserved
 * optimistic user row in its exact owner scope.
 */
export function releaseUnconfirmedQueueSend(input: {
  sessionID: string
  messageID: string
  directory?: string | null
}): void {
  const directory = input.directory ?? null
  _optimisticRemove?.({
    sessionID: input.sessionID,
    directory,
    messageID: input.messageID,
  })
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

export function dirStoreForDirectory(
  directory: string,
  options?: { bootstrap?: boolean },
) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory, options)
}

function dirStoreForSession(sessionId: string, directoryOverride?: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = directoryOverride ?? getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

/** Resolve TranscriptRepository for a session scope (bound Query, else store adapter). */
function transcriptRepositoryForSession(
  sessionId: string,
  directoryOverride?: string | null,
): { repository: TranscriptRepository; directory: string; store: DirectoryStoreApi } {
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride ?? undefined)
  const resolvedDirectory = directory ?? dir() ?? ""
  const repository = getTranscriptRepository()
    ?? resolveTranscriptRepositoryForStore(resolvedDirectory, store)
  return { repository, directory: resolvedDirectory, store }
}

function readSessionTranscript(
  sessionId: string,
  directoryOverride?: string | null,
): { data: TranscriptData; directory: string; repository: TranscriptRepository; store: DirectoryStoreApi } {
  const { repository, directory, store } = transcriptRepositoryForSession(sessionId, directoryOverride)
  return {
    repository,
    directory,
    store,
    data: repository.getTranscript(transcriptScope(directory, sessionId)),
  }
}

function readSessionMessages(sessionId: string, directoryOverride?: string | null): Message[] {
  return messagesFromTranscriptData(readSessionTranscript(sessionId, directoryOverride).data)
}

function readSessionMessageCount(sessionId: string, directoryOverride?: string | null): number {
  return readSessionTranscript(sessionId, directoryOverride).data.messageOrder.length
}

/**
 * Provider/model of the session's last assistant message — the authoritative
 * "session provider" for utility calls (notes distillation etc.), independent
 * of what the composer picker currently points at.
 */
export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const messages = readSessionMessages(sessionId)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i] as { role?: string; providerID?: string; modelID?: string }
      if (info?.role === "assistant" && typeof info.providerID === "string" && info.providerID
        && typeof info.modelID === "string" && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  } catch {
    return null
  }
}

function updateLiveSession(session: Session, directory?: string): boolean {
  const stores = _childStores
  if (!stores) return false

  const candidates = directory
    ? [[directory, stores.getChild(directory)] as const]
    : stores.children

  for (const [, store] of candidates) {
    if (!store) continue
    const current = store.getState().session
    const index = current.findIndex((item) => item.id === session.id)
    if (index === -1) continue

    const next = [...current]
    next[index] = mergeSessionDirectoryMetadata(session, current[index])
    store.setState({ session: next })
    return true
  }

  return false
}

export function mirrorSessionIntoLiveStores(session: Session, directory?: string): void {
  if (directory && updateLiveSession(session, directory)) {
    return
  }
  updateLiveSession(session)
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const direct = (error as { status?: unknown }).status
  if (typeof direct === "number") return direct
  const response = (error as { response?: { status?: unknown } }).response
  return typeof response?.status === "number" ? response.status : null
}

export type SendFailureKind = "pre-dispatch" | "definitive-rejection" | "ambiguous-dispatched"

class SendDispatchError extends Error {
  readonly kind: SendFailureKind
  readonly cause: unknown
  readonly messageID?: string

  constructor(kind: SendFailureKind, cause: unknown, messageID?: string) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "SendDispatchError"
    this.kind = kind
    this.cause = cause
    this.messageID = messageID
  }
}

export function getSendFailureKind(error: unknown): SendFailureKind | null {
  return error instanceof SendDispatchError ? error.kind : null
}

function isAmbiguousSendFailure(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status === 503 || status === 504 || status === 408) return true
  if (error instanceof TypeError) return true
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : typeof error === "string"
      ? error.toLowerCase()
      : ""

  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("network error")
    || message.includes("gateway timeout")
    || message.includes("econnreset")
    || message.includes("socket hang up")
}

export function classifySendFailure(error: unknown, transportEntered: boolean): SendFailureKind {
  if (!transportEntered) return "pre-dispatch"
  if (isAmbiguousSendFailure(error)) return "ambiguous-dispatched"
  return getErrorStatus(error) === null ? "ambiguous-dispatched" : "definitive-rejection"
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
//
// Relay: `isConnected` is the event stream, not the tunnel. A live tunnel can
// already carry the send HTTP request while the event WS is reconnecting. Skip
// the 500ms OpenCode health probe in that case — it is what surfaces as
// "Connection lost (health_probe_unhealthy)" on a working tunnel.
const CONNECTION_GRACE_MS = 2000
const STALE_STREAM_HEAL_GRACE_MS = 5000
const SEND_DISPATCH_TIMEOUT_MS = 30_000

export async function waitForConnectionOrThrow(): Promise<void> {
  const healStaleStream = isStreamActivityStale()
  if (healStaleStream) {
    requestStreamReconnect("send_stream_stale")
  }
  const deadline = Date.now() + (healStaleStream ? STALE_STREAM_HEAL_GRACE_MS : CONNECTION_GRACE_MS)
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected && !isStreamActivityStale()) return
    if (isRelayTransportReady() && !isStreamActivityStale()) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) {
      if (!isStreamActivityStale()) return
    }
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

function withSendDispatchTimeout(send: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestStreamReconnect("send_timeout")
      reject(new DOMException("Send timed out", "TimeoutError"))
    }, SEND_DISPATCH_TIMEOUT_MS)
    send.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type SessionListSnapshot = {
  directory: string
  sessions: Session[]
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function restoreGlobalSessionSnapshot(session: Session | null): void {
  if (!session) return
  useGlobalSessionsStore.getState().upsertSession(session)
}

function upsertSessionIntoDirectoryStore(store: DirectoryStoreApi, session: Session): Session {
  const sanitized = stripSessionDiffSnapshots(session)
  const sessions = [...store.getState().session]
  const searchResult = Binary.search(sessions, sanitized.id, (item) => item.id)
  if (searchResult.found) {
    const merged = mergeSessionDirectoryMetadata(sanitized, sessions[searchResult.index])
    sessions[searchResult.index] = merged
    store.setState({ session: sessions })
    return merged
  }
  sessions.splice(searchResult.index, 0, sanitized)
  store.setState({ session: sessions })
  return sanitized
}

/**
 * Cold start / lazy directory stores may show a session in the sidebar (global
 * index) and even load its messages before `state.session` contains the row.
 * Fork needs a real Session object in the target child store for title/copy
 * isolation — hydrate from global snapshot or session.get when missing.
 */
async function ensureForkSourceSession(
  sessionId: string,
  store: DirectoryStoreApi,
  directory: string,
): Promise<Session> {
  const live = store.getState().session.find((session) => session.id === sessionId)
  if (live) return live

  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  if (globalSnapshot) {
    console.info("[session-fork] hydrating source session from global store", {
      sessionId,
      directory,
    })
    return upsertSessionIntoDirectoryStore(store, globalSnapshot)
  }

  console.info("[session-fork] fetching source session via session.get", {
    sessionId,
    directory,
  })
  try {
    const fetched = await opencodeClient.getSession(sessionId, directory)
    return upsertSessionIntoDirectoryStore(store, fetched)
  } catch (error) {
    console.error("[session-fork] failed to hydrate source session", {
      sessionId,
      directory,
      error,
    })
    throw new Error("Fork source session is unavailable")
  }
}

function getSessionDirectory(sessionId: string): string | undefined {
  return findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || dir()
}

function findSessionDirectoryInChildStores(sessionId: string): string | null {
  const stores = _childStores
  if (!stores || !sessionId) return null

  // Prefer session catalog / status / permission / question ownership.
  // Do not use child-store message maps (Ticket 09 batch 1B — Query sole transcript authority).
  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  // Query canonical scopes when catalog/status has not indexed the session yet.
  try {
    const repository = getTranscriptRepository() as
      | (TranscriptRepository & {
        getCacheBudget?: () => {
          listCanonical: (filter?: { directory?: string }) => Array<{ scope: { directory: string; sessionID: string } }>
        }
      })
      | null
    const inventory = repository?.getCacheBudget?.().listCanonical()
    if (inventory) {
      const matches = inventory
        .filter((entry) => entry.scope.sessionID === sessionId)
        .map((entry) => entry.scope.directory)
      const unique = [...new Set(matches)]
      if (unique.length === 1) return unique[0] ?? null
    }
  } catch {
    // Ignore inventory failures; fall through.
  }

  return null
}

function getSessionReplyClient(sessionId?: string): OpencodeClient {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  if (directory) {
    return opencodeClient.getScopedSdkClient(directory)
  }
  return sdk()
}

function restoreFilePartsToInput(fileParts: Array<Record<string, unknown>>): void {
  // Fork path still uses legacy pendingInput + attachment buckets.
  useInputStore.getState().clearAttachedFiles()
  for (const filePart of fileParts) {
    const url = typeof filePart.url === "string" ? filePart.url : ""
    const mime = typeof filePart.mime === "string" ? filePart.mime : "application/octet-stream"
    const filename = typeof filePart.filename === "string" ? filePart.filename : "attachment"
    if (url) {
      useInputStore.getState().addRestoredAttachment({ url, mimeType: mime, filename })
    }
  }
}

const sessionTitlesForRestoration = (): ReadonlyMap<string, string> =>
  new Map(Array.from(getAllSyncSessionMap(), ([id, session]) => [id, session.title || id]))

function isAuthoredFilePart(part: Record<string, unknown>): boolean {
  if (part.type !== "file") return false
  if (isSyntheticPart(part as never)) return false
  return true
}

/** Slim or url-less authored file parts cannot rebuild attachments. */
function sentMessageFilePartNeedsExactBody(part: Record<string, unknown>): boolean {
  if (!isAuthoredFilePart(part)) return false
  if ((part as { slim?: unknown }).slim === true) return true
  return typeof part.url !== "string" || part.url.length === 0
}

function sentMessageFilePartsNeedExactBody(parts: readonly Record<string, unknown>[]): boolean {
  return parts.some(sentMessageFilePartNeedsExactBody)
}

/**
 * Fill slim / url-less file parts before Composer restoration so an edit
 * cannot silently drop attachments. Complete file parts skip the Host fetch.
 * Captures generation so a stale materialize cannot commit into a new runtime.
 */
async function ensureSentMessagePartsForComposerRestoration(input: {
  directory?: string
  sessionID: string
  messageID: string
  parts: readonly Record<string, unknown>[]
  isCurrent?: () => boolean
}): Promise<Array<Record<string, unknown>>> {
  let parts = [...input.parts]
  if (!sentMessageFilePartsNeedExactBody(parts)) return parts

  const generation = getRuntimeGeneration()
  const directory = input.directory ?? ""
  try {
    await materializeTranscriptMessage(directory, input.sessionID, input.messageID, {
      priority: "user",
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`composer-restoration-materialize-failed: ${detail}`)
  }
  if (input.isCurrent && !input.isCurrent()) {
    throw new Error("Session history mutation aborted because the runtime changed")
  }
  if (getRuntimeGeneration() !== generation) {
    throw new Error("Session history mutation aborted because the runtime changed")
  }

  const { repository, directory: transcriptDirectory } = transcriptRepositoryForSession(input.sessionID, directory)
  parts = [...repository.getParts(
    transcriptScope(transcriptDirectory, input.sessionID),
    input.messageID,
  )] as unknown as Array<Record<string, unknown>>
  if (sentMessageFilePartsNeedExactBody(parts)) {
    throw new Error("composer-restoration-incomplete-attachment")
  }
  return parts
}

async function commitSentPartsToDraftKey(input: {
  key: DraftKey
  parts: readonly Record<string, unknown>[]
  directory?: string | null
}): Promise<{ payload: ComposerRestorationPayload; commit: Awaited<ReturnType<typeof commitComposerRestoration>> }> {
  if (sentMessageFilePartsNeedExactBody(input.parts)) {
    throw new Error("composer-restoration-incomplete-attachment")
  }
  const payload = await buildSentMessageComposerRestoration(input.parts, {
    sessionTitles: sessionTitlesForRestoration(),
    directory: input.directory,
  })
  const store = useInputStore.getState()
  const current = store.getDraft(input.key)
  const commit = await commitComposerRestoration({
    key: input.key,
    expectedRevision: current?.revision ?? "absent",
    payload,
    runtime: store.captureDraftRuntime(),
  })
  return { payload, commit }
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.question
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string }> | undefined>) {
      if (requests?.some((request) => request.id === requestId)) {
        return directory
      }
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

export function isQuestionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Question(?:\.)?NotFoundError|Question request not found/i.test(message)
}

function removeQuestionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().question ?? {}
    let nextQuestion: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextQuestion ??= { ...current }
      if (nextRequests.length > 0) {
        nextQuestion[candidateSessionId] = nextRequests
      } else {
        delete nextQuestion[candidateSessionId]
      }
      removed = true
    }

    if (nextQuestion) {
      store.setState({ question: nextQuestion })
    }
  }

  return removed
}

function getRequestReplyClient(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): OpencodeClient {
  const requestDirectory = resolveDirectoryForBlockingRequest(type, sessionId, requestId)
  if (requestDirectory) {
    return opencodeClient.getScopedSdkClient(requestDirectory)
  }
  return getSessionReplyClient(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
  metadata?: Record<string, unknown>,
): Promise<Session | null> {
  try {
    const session = await opencodeClient.createSession({
      title,
      parentID: parentID ?? undefined,
      metadata,
    }, directoryOverride ?? dir())

    // Point of no return: session exists server-side. Post-processing
    // failures below (routing, selection, upsert) must not be treated as
    // create failures — the session is real and will arrive via SSE.
    const sessionDirectory = (session as { directory?: string | null }).directory ?? null
    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
    }
    useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

export async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
): Promise<Session> {
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const current = await opencodeClient.getSession(sessionId, targetDirectory)
  const nextMetadata = updater(getSessionMetadata(current))
  const updated = await opencodeClient.updateSession(sessionId, { metadata: nextMetadata }, targetDirectory)
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = (updated as { directory?: string | null }).directory ?? targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  return updated
}

async function cleanupReviewMetadataBeforeDelete(sessionId: string, directory?: string | null): Promise<void> {
  let session: Session
  try {
    session = await opencodeClient.getSession(sessionId, directory ?? getSessionDirectory(sessionId))
  } catch {
    return
  }
  if (!isReviewSession(session)) return
  const originalSessionID = getOriginalSessionID(session)
  if (!originalSessionID) return
  try {
    await patchSessionMetadata(originalSessionID, directory ?? getSessionDirectory(originalSessionID), (metadata) =>
      withoutReviewSessionLink(metadata, sessionId),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not found/i.test(message)) return
    console.warn("[session-actions] review metadata cleanup failed before delete", error)
  }
}

/** Optimistically remove a session from every live child store that has it. */
function optimisticRemoveSession(sessionId: string, preferredDirectory?: string): SessionListSnapshot[] {
  if (!_childStores) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    if (!current.session.some((session) => session.id === sessionId)) {
      continue
    }
    snapshots.push({ directory, sessions: current.session })
    store.setState({ session: current.session.filter((session) => session.id !== sessionId) })
  }

  return snapshots
}

function restoreSessionListSnapshots(snapshots: SessionListSnapshot[]): void {
  if (!_childStores) return
  for (const snapshot of snapshots) {
    const store = _childStores.children.get(snapshot.directory)
    if (!store) continue
    store.setState({ session: snapshot.sessions })
  }
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

/** Soft-delete undo window. Hard delete only hits the server after this delay. */
export const SESSION_DELETE_UNDO_MS = 10_000

type PendingDeleteEntry = {
  sessionId: string
  directory?: string
  listSnapshots: SessionListSnapshot[]
  globalSnapshot: Session | null
  wasCurrent: boolean
}

type PendingDeleteBatch = {
  entries: PendingDeleteEntry[]
  timer: ReturnType<typeof setTimeout>
  onSettled?: (result: { deletedIds: string[]; failedIds: string[] }) => void
}

const pendingDeleteBatches = new Map<string, PendingDeleteBatch>()
let pendingDeleteBatchSeq = 0

function clearArchivedTimestamp(session: Session): Session {
  if (session.time?.archived === undefined) return session
  const restTime = { ...session.time }
  delete restTime.archived
  return {
    ...session,
    time: restTime,
  }
}

function restorePendingDeleteEntry(entry: PendingDeleteEntry): void {
  useGlobalSessionsStore.getState().clearSessionsPendingDeletion([entry.sessionId])
  restoreSessionListSnapshots(entry.listSnapshots)
  restoreGlobalSessionSnapshot(entry.globalSnapshot)
  if (entry.wasCurrent) {
    useSessionUIStore.getState().setCurrentSession(entry.sessionId, entry.directory ?? null)
  }
}

function optimisticallyRemoveSessionForDelete(sessionId: string, directory?: string): PendingDeleteEntry {
  const sessionDirectory = directory ?? getSessionDirectory(sessionId)
  useGlobalSessionsStore.getState().markSessionsPendingDeletion([sessionId])
  const listSnapshots = optimisticRemoveSession(sessionId, sessionDirectory)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  useGlobalSessionsStore.getState().removeSessions([sessionId])
  const ui = useSessionUIStore.getState()
  const wasCurrent = ui.currentSessionId === sessionId
  if (wasCurrent) {
    ui.setCurrentSession(null)
  }
  return {
    sessionId,
    directory: sessionDirectory,
    listSnapshots,
    globalSnapshot,
    wasCurrent,
  }
}

/** Commit a delete that has already been optimistically removed from local stores. */
async function commitRemovedSessionDelete(sessionId: string, directory?: string): Promise<boolean> {
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, directory)
    const deleted = await opencodeClient.deleteSession(sessionId, directory)
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    optimisticRemoveSession(sessionId, directory)
    useGlobalSessionsStore.getState().removeSessions([sessionId])
    cleanupSessionWorktreeMetadata(sessionId)
    useGlobalSessionsStore.getState().clearSessionsPendingDeletion([sessionId])
    return true
  } catch (error) {
    console.error("[session-actions] commitRemovedSessionDelete failed", error)
    // The server cascade-deletes child sessions when the parent is removed.
    // Subsequent delete attempts for those children return 404; treat as
    // success since the session was already deleted by the cascade.
    if ((error as { status?: number })?.status === 404) {
      optimisticRemoveSession(sessionId, directory)
      useGlobalSessionsStore.getState().removeSessions([sessionId])
      cleanupSessionWorktreeMetadata(sessionId)
      useGlobalSessionsStore.getState().clearSessionsPendingDeletion([sessionId])
      return true
    }
    return false
  }
}

export async function deleteSession(sessionId: string, _options?: Record<string, unknown>): Promise<boolean> {
  const entry = optimisticallyRemoveSessionForDelete(sessionId)
  const ok = await commitRemovedSessionDelete(sessionId, entry.directory)
  if (ok) return true
  restorePendingDeleteEntry(entry)
  return false
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(sessionId: string, directory: string): Promise<boolean> {
  if (!_childStores) return false
  const entry = optimisticallyRemoveSessionForDelete(sessionId, directory)
  const ok = await commitRemovedSessionDelete(sessionId, directory)
  if (ok) return true
  restorePendingDeleteEntry(entry)
  return false
}

/**
 * Optimistically remove sessions and permanently delete them after `delayMs`.
 * Call `cancelScheduledSessionDeletes` within the window to restore local state
 * without hitting the server.
 */
export function scheduleSessionDeletes(
  sessionIds: string[],
  options?: {
    delayMs?: number
    onSettled?: (result: { deletedIds: string[]; failedIds: string[] }) => void
  },
): { batchId: string; scheduledIds: string[] } {
  const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)))
  if (uniqueIds.length === 0) {
    return { batchId: "", scheduledIds: [] }
  }

  const entries = uniqueIds.map((sessionId) => optimisticallyRemoveSessionForDelete(sessionId))
  const batchId = `session-delete-${Date.now()}-${pendingDeleteBatchSeq += 1}`
  const delayMs = options?.delayMs ?? SESSION_DELETE_UNDO_MS

  const timer = setTimeout(() => {
    void (async () => {
      const batch = pendingDeleteBatches.get(batchId)
      if (!batch) return
      pendingDeleteBatches.delete(batchId)

      const deletedIds: string[] = []
      const failedIds: string[] = []
      for (const entry of batch.entries) {
        const ok = await commitRemovedSessionDelete(entry.sessionId, entry.directory)
        if (ok) {
          deletedIds.push(entry.sessionId)
        } else {
          failedIds.push(entry.sessionId)
          restorePendingDeleteEntry(entry)
        }
      }
      batch.onSettled?.({ deletedIds, failedIds })
    })()
  }, delayMs)

  pendingDeleteBatches.set(batchId, {
    entries,
    timer,
    onSettled: options?.onSettled,
  })

  return { batchId, scheduledIds: uniqueIds }
}

/** Cancel a pending delayed delete batch and restore optimistic local state. */
export function cancelScheduledSessionDeletes(batchId: string): boolean {
  if (!batchId) return false
  const batch = pendingDeleteBatches.get(batchId)
  if (!batch) return false
  clearTimeout(batch.timer)
  pendingDeleteBatches.delete(batchId)
  for (const entry of [...batch.entries].reverse()) {
    restorePendingDeleteEntry(entry)
  }
  return true
}

/** Test helper: drop pending timers without restoring UI. */
export function clearScheduledSessionDeletesForTests(): void {
  for (const batch of pendingDeleteBatches.values()) {
    clearTimeout(batch.timer)
    useGlobalSessionsStore.getState().clearSessionsPendingDeletion(
      batch.entries.map((entry) => entry.sessionId),
    )
  }
  pendingDeleteBatches.clear()
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const snapshots = optimisticRemoveSession(sessionId, sessionDirectory)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  const archivedAt = Date.now()
  useGlobalSessionsStore.getState().archiveSessions([sessionId], archivedAt)
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory)
    const archived = await opencodeClient.updateSession(sessionId, { time: { archived: archivedAt } }, sessionDirectory)
    if (!archived) {
      throw new Error("session.update failed: server did not return the archived session")
    }
    useGlobalSessionsStore.getState().upsertSession(archived)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    restoreSessionListSnapshots(snapshots)
    restoreGlobalSessionSnapshot(globalSnapshot)
    return false
  }
}

/** Restore an archived session to the active list (`time.archived = 0`). */
export async function unarchiveSession(sessionId: string): Promise<boolean> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  const optimistic = globalSnapshot ? clearArchivedTimestamp(globalSnapshot) : null

  if (optimistic) {
    useGlobalSessionsStore.getState().upsertSession(optimistic)
    if (sessionDirectory && _childStores) {
      const store = _childStores.children.get(sessionDirectory)
      if (store) {
        upsertSessionIntoDirectoryStore(store, optimistic)
      }
    }
  }

  try {
    const updated = await opencodeClient.updateSession(
      sessionId,
      { time: { archived: 0 } },
      sessionDirectory,
    )
    if (!updated) {
      throw new Error("session.update failed: server did not return the unarchived session")
    }
    const restored = clearArchivedTimestamp(updated)
    useGlobalSessionsStore.getState().upsertSession(restored)
    if (sessionDirectory && _childStores) {
      const store = _childStores.children.get(sessionDirectory)
      if (store) {
        upsertSessionIntoDirectoryStore(store, restored)
      } else {
        mirrorSessionIntoLiveStores(restored, sessionDirectory)
      }
    } else {
      mirrorSessionIntoLiveStores(restored, sessionDirectory)
    }
    return true
  } catch (error) {
    console.error("[session-actions] unarchiveSession failed", error)
    if (globalSnapshot) {
      useGlobalSessionsStore.getState().upsertSession(globalSnapshot)
      if (globalSnapshot.time?.archived) {
        optimisticRemoveSession(sessionId, sessionDirectory)
      }
    }
    return false
  }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const current = getGlobalSessionSnapshot(sessionId)
  const metadata = (current as Session & { metadata?: Record<string, unknown> } | null)?.metadata ?? {}
  const openchamber = metadata.openchamber && typeof metadata.openchamber === "object"
    ? metadata.openchamber as Record<string, unknown>
    : {}
  const titleRefresh = openchamber.titleRefresh && typeof openchamber.titleRefresh === "object"
    ? openchamber.titleRefresh as Record<string, unknown>
    : {}
  const activityUpdatedAt = current ? getSessionActivityUpdatedAt(current) : 0
  const session = await opencodeClient.updateSession(sessionId, {
    title,
    metadata: {
      ...metadata,
      openchamber: {
        ...openchamber,
        titleRefresh: {
          ...titleRefresh,
          activityUpdatedAt,
        },
      },
    },
  }, sessionDirectory)
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
}

/**
 * Force server-side smart title generation for a session.
 * Writes `metadata.openchamber.titleRefresh.requestedAt`; the session-title
 * runtime picks that up and regenerates the title from recent messages.
 */
export async function requestSessionSmartTitle(sessionId: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const current = getGlobalSessionSnapshot(sessionId)
  const metadata = (current as Session & { metadata?: Record<string, unknown> } | null)?.metadata ?? {}
  const openchamber = metadata.openchamber && typeof metadata.openchamber === "object"
    ? metadata.openchamber as Record<string, unknown>
    : {}
  const titleRefresh = openchamber.titleRefresh && typeof openchamber.titleRefresh === "object"
    ? openchamber.titleRefresh as Record<string, unknown>
    : {}
  const lastAutoTitle = typeof current?.title === "string" && current.title.trim()
    ? current.title.trim()
    : (typeof titleRefresh.lastAutoTitle === "string" ? titleRefresh.lastAutoTitle : undefined)
  const session = await opencodeClient.updateSession(sessionId, {
    metadata: {
      ...metadata,
      openchamber: {
        ...openchamber,
        titleRefresh: {
          ...titleRefresh,
          ...(lastAutoTitle ? { lastAutoTitle } : {}),
          requestedAt: Date.now(),
        },
      },
    },
  }, sessionDirectory)
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.share({ sessionID: sessionId, directory: sessionDirectory })
  const session = stripSessionDiffSnapshots(assertSdkData(result, "session.share"))
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: sessionDirectory })
  const session = stripSessionDiffSnapshots(assertSdkData(result, "session.unshare"))
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

import { ascendingId } from "./message-id"

type SendTargetCapture = {
  store: DirectoryStoreApi
  isCurrent: () => boolean
}

type RuntimeTransportCapture = { identity: string; generation: number }

function captureSendTarget(directory?: string | null): SendTargetCapture {
  const stores = _childStores
  const targetDirectory = directory ?? _getDirectory()
  if (!stores || !targetDirectory) {
    const store = directory ? dirStoreForDirectory(directory) : dirStore()
    return { store, isCurrent: () => true }
  }
  const generationStores = stores as ChildStoreManager & {
    captureChild?: (value: string) => { store: DirectoryStoreApi }
    isCurrentChildCapture?: (capture: unknown) => boolean
  }
  const childCapture = generationStores.captureChild?.(targetDirectory)
  if (childCapture && generationStores.isCurrentChildCapture) {
    return { store: childCapture.store, isCurrent: () => generationStores.isCurrentChildCapture?.(childCapture) === true }
  }
  const store = stores.ensureChild(targetDirectory)
  return { store, isCurrent: () => stores.getChild(targetDirectory) === store }
}

function captureRuntimeTransport(): RuntimeTransportCapture {
  return { identity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }
}

function isCurrentSendTarget(target: SendTargetCapture, transport: RuntimeTransportCapture): boolean {
  return target.isCurrent()
    && getRuntimeTransportIdentity() === transport.identity
    && getRuntimeGeneration() === transport.generation
}

function assertCurrentSendTarget(target: SendTargetCapture, transport: RuntimeTransportCapture): void {
  if (!isCurrentSendTarget(target, transport)) throw new Error("Send target changed before transport dispatch")
}

/**
 * Immutable ticket from a synchronous optimistic begin. Captures the fixed
 * messageID, target directory child-store generation, and runtime transport so
 * later settle/rollback stay scoped to the begin-time authority.
 */
export type OptimisticSendTicket = {
  readonly messageID: string
  readonly sessionId: string
  readonly directory: string | null
  readonly capture: SendTargetCapture
  readonly transport: RuntimeTransportCapture
}

export type BeginOptimisticSendInput = {
  sessionId: string
  /** Raw authored text for temporary display (and text-part fallback). */
  content: string
  /** Provider/model used only for the temporary optimistic row display. */
  providerID: string
  modelID: string
  agent?: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  parts?: readonly Part[]
  /** Pre-generated messageID — if omitted, one is generated via ascendingId */
  messageID?: string
  onOptimisticInsert?: () => void
  onMessageID?: (messageID: string) => void
  beforeOptimisticInsert?: () => void
}

/**
 * Synchronously paint the optimistic user row + sending status before any
 * await. Call from ChatInput before the first async boundary so the list and
 * pending-send UI update immediately.
 */
export function beginOptimisticSend(input: BeginOptimisticSendInput): OptimisticSendTicket {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new SendDispatchError("pre-dispatch", new Error("Optimistic refs not set — is useSync() mounted?"))
  }

  try {
    const targetDirectory: string | null = input.directory ?? dir() ?? null
    const capture = captureSendTarget(targetDirectory)
    const transport = captureRuntimeTransport()
    assertCurrentSendTarget(capture, transport)
    input.beforeOptimisticInsert?.()
    assertCurrentSendTarget(capture, transport)

    const messageID = input.messageID ?? ascendingId("msg")
    input.onMessageID?.(messageID)

    // Mark pending send before the optimistic user row so the assistant status
    // can show "sending message" for every runtime while the request is in flight,
    // and so MessageList can latch `anchoring-new-turn` on that same insert.
    useSessionUIStore.getState().markMessageSending?.(input.sessionId, messageID)
    markPendingUserSendAnimation(input.sessionId)

    // Paint the user bubble + busy status immediately. Connection recovery may
    // take up to CONNECTION_GRACE_MS; the list must not wait on that.
    optimisticInsertUserMessage({
      sessionId: input.sessionId,
      messageID,
      content: input.content,
      providerID: input.providerID,
      modelID: input.modelID,
      agent: input.agent,
      directory: targetDirectory,
      files: input.files,
      parts: input.parts,
    })
    input.onOptimisticInsert?.()

    return {
      messageID,
      sessionId: input.sessionId,
      directory: targetDirectory,
      capture,
      transport,
    }
  } catch (error) {
    if (error instanceof SendDispatchError) throw error
    throw new SendDispatchError(
      getSendFailureKind(error) ?? classifySendFailure(error, false),
      error,
    )
  }
}

/**
 * Drop the optimistic row and restore session idle only while the begin-time
 * capture+transport are still current. A stale runtime/child-store must not
 * call the live `_optimisticRemove` — that hook targets the current store and
 * can delete a same-ID row that belongs to a newer begin. Does not clear
 * pendingSendMessageIDs — callers that own the full settle lifecycle clear in
 * `finally`; standalone rollback does.
 */
function rollbackOptimisticSendState(ticket: OptimisticSendTicket): void {
  if (!isCurrentSendTarget(ticket.capture, ticket.transport)) return
  if (!_optimisticRemove) return

  _optimisticRemove({
    sessionID: ticket.sessionId,
    directory: ticket.directory,
    messageID: ticket.messageID,
  })

  const s = ticket.capture.store.getState()
  const now = Date.now()
  ticket.capture.store.setState({
    session_status: {
      ...s.session_status,
      [ticket.sessionId]: { type: "idle" as const },
    },
    session_status_observed_at: {
      ...s.session_status_observed_at,
      [ticket.sessionId]: now,
    },
  })
}

/**
 * Idempotent rollback for a begin ticket: drop the optimistic row while the
 * begin-time capture+transport remain current, and always clear
 * pendingSendMessageIDs for this messageID (clearMessageSending is ID-matched
 * so a newer pending send is preserved).
 */
export function rollbackOptimisticSend(ticket: OptimisticSendTicket): void {
  rollbackOptimisticSendState(ticket)
  useSessionUIStore.getState().clearMessageSending?.(ticket.sessionId, ticket.messageID)
}

/**
 * Settle a previously begun ticket: connection grace wait, SDK dispatch, send
 * confirmation, and ambiguous-dispatch confirmation / rollback. Never re-inserts
 * the optimistic row — the ticket already owns that paint.
 */
export async function settleOptimisticSend(input: {
  ticket: OptimisticSendTicket
  /** Retains optimistic state after an ambiguous dispatched failure for queue reconciliation. */
  preserveOptimisticOnAmbiguous?: boolean
  /** Send responses can confirm a queue operation before SSE confirmation is available. */
  onSendConfirmed?: (messageID: string) => void
  /** The actual API call — receives the ticket messageID so the server uses the same ID */
  send: (messageID: string) => Promise<void>
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new SendDispatchError("pre-dispatch", new Error("Optimistic refs not set — is useSync() mounted?"))
  }

  const { ticket } = input
  const { capture, transport, messageID, sessionId, directory: targetDirectory } = ticket
  let transportEntered = false
  try {
    await waitForConnectionOrThrow()
    assertCurrentSendTarget(capture, transport)
    transportEntered = true
    await withSendDispatchTimeout(input.send(messageID))
    if (!isCurrentSendTarget(capture, transport)) {
      throw new SendDispatchError(
        "ambiguous-dispatched",
        new Error("Send target changed after transport dispatch"),
        messageID,
      )
    }
    input.onSendConfirmed?.(messageID)
  } catch (error) {
    const failureKind = getSendFailureKind(error) ?? classifySendFailure(error, transportEntered)
    const dispatchError = error instanceof SendDispatchError
      ? error
      : new SendDispatchError(failureKind, error, messageID)
    if (!isCurrentSendTarget(capture, transport)) throw dispatchError
    const acceptedRecords = failureKind === "ambiguous-dispatched" && !input.preserveOptimisticOnAmbiguous
      ? await fetchRecentSendConfirmationRecords(sessionId, messageID, targetDirectory)
      : null

    if (acceptedRecords && isCurrentSendTarget(capture, transport)) {
      materializeConfirmedSendRecords(capture.store, sessionId, messageID, acceptedRecords, {
        directory: targetDirectory ?? undefined,
      })
      _optimisticConfirm?.({
        sessionID: sessionId,
        directory: targetDirectory,
        messageID,
      })
      return
    }

    if (input.preserveOptimisticOnAmbiguous && failureKind === "ambiguous-dispatched") throw dispatchError
    // Rollback optimistic row + idle; pending clear stays in finally (single clear).
    rollbackOptimisticSendState(ticket)
    throw dispatchError
  } finally {
    // Clear only this messageID so a concurrent newer pending send is preserved.
    useSessionUIStore.getState().clearMessageSending?.(sessionId, messageID)
  }
}

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 *
 * Insert the optimistic user row before the connection grace wait so a
 * long-idle reconnect cannot leave the composer cleared / status busy while
 * the chat list still shows the pre-send snapshot.
 *
 * Pass an existing `ticket` from `beginOptimisticSend` to skip re-insert and
 * reuse the same messageID for the SDK call. Without a ticket, behavior matches
 * the historical begin+settle path.
 */
export async function optimisticSend(input: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  parts?: readonly Part[]
  /** Pre-generated messageID — if omitted, one is generated via ascendingId */
  messageID?: string
  /**
   * Ticket from a prior `beginOptimisticSend`. When present, skips insert and
   * settles with the ticket's fixed messageID / captures (no double insert).
   */
  ticket?: OptimisticSendTicket
  /** Retains optimistic state after an ambiguous dispatched failure for queue reconciliation. */
  preserveOptimisticOnAmbiguous?: boolean
  /** Send responses can confirm a queue operation before SSE confirmation is available. */
  onSendConfirmed?: (messageID: string) => void
  onOptimisticInsert?: () => void
  onMessageID?: (messageID: string) => void
  beforeOptimisticInsert?: () => void
  /** The actual API call — receives the optimistic messageID so the server can use the same ID */
  send: (messageID: string) => Promise<void>
}): Promise<void> {
  const ticket = input.ticket ?? beginOptimisticSend({
    sessionId: input.sessionId,
    content: input.content,
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    directory: input.directory,
    files: input.files,
    parts: input.parts,
    messageID: input.messageID,
    onOptimisticInsert: input.onOptimisticInsert,
    onMessageID: input.onMessageID,
    beforeOptimisticInsert: input.beforeOptimisticInsert,
  })

  await settleOptimisticSend({
    ticket,
    preserveOptimisticOnAmbiguous: input.preserveOptimisticOnAmbiguous,
    onSendConfirmed: input.onSendConfirmed,
    send: input.send,
  })
}

/**
 * Pure optimistic insertion helper — inserts a user message into the child
 * store and shadow Map without waiting for connection or calling send.
 * Used by the non-combined (fallback) send path and optimisticSend.
 *
 * Respects the shadow Map protocol: registers with real sessionID + provided
 * messageID so mergeOptimisticPage can deduplicate. If the repository already
 * holds a renderable row (message + parts), skips insertion. A hydration
 * shell with empty parts still inserts so the user bubble can paint.
 * Returns false when the optimistic shadow ref is not mounted.
 */
export function optimisticInsertUserMessage(input: {
  sessionId: string
  messageID: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  parts?: readonly Part[]
}): boolean {
  if (!_optimisticAdd) return false

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  const resolvedDirectory = targetDirectory ?? dir() ?? ""
  // Ticket 09 batch 1B: dedupe against Query/repository transcript, not child-store.message.
  // Skip only when the stored row is renderable (message + parts). A hydration
  // shell with empty parts must still receive the optimistic insert.
  if (hasStoredSessionMessage(store, input.sessionId, input.messageID, resolvedDirectory)) {
    const state = store.getState()
    const now = Date.now()
    store.setState({
      session_status: {
        ...state.session_status,
        [input.sessionId]: { type: "busy" as const },
      },
      session_status_observed_at: {
        ...state.session_status_observed_at,
        [input.sessionId]: now,
      },
    })
    return false
  }

  const optimisticParts: Part[] = input.parts
    ? input.parts.map((part) => ({
        ...part,
        id: typeof part.id === "string" && part.id ? part.id : ascendingId("prt"),
        messageID: input.messageID,
        sessionID: input.sessionId,
        __openchamberOptimistic: true,
      } as unknown as Part))
    : [{ id: ascendingId("prt"), type: "text", text: input.content, messageID: input.messageID, sessionID: input.sessionId, __openchamberOptimistic: true } as unknown as Part]
  if (!input.parts && input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: ascendingId("prt"), messageID: input.messageID, sessionID: input.sessionId, type: "file", mime: f.mime, url: f.url, filename: f.filename, __openchamberOptimistic: true } as unknown as Part)
    }
  }

  const now = Date.now()
  const optimisticMessage = {
    id: input.messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: `${input.providerID}/${input.modelID}`,
    metadata: {} as Record<string, unknown>,
    time: { created: now, completed: 0 },
  } as unknown as Message

  const sendDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(input.sessionId, targetDirectory).data,
  )
  _optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })
  const sendDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(input.sessionId, targetDirectory).data,
  )
  try {
    if (sendDiffBefore && sendDiffAfter) {
      recordTranscriptDiff({
        trigger: "user-send",
        sessionID: input.sessionId,
        directory: resolvedDirectory,
        transport: getRuntimeTransportIdentity(),
        generation: getRuntimeGeneration(),
        before: sendDiffBefore,
        after: sendDiffAfter,
      })
    }
  } catch {
    // Diagnostics must never affect optimistic insert.
  }

  // Set busy status
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
    session_status_observed_at: {
      ...current.session_status_observed_at,
      [input.sessionId]: now,
    },
  })

  return true
}

export type FetchRecentSendConfirmationOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** Override default attempt count (default SEND_CONFIRMATION_REFETCH_ATTEMPTS). */
  attempts?: number
  /** Delay between attempts in ms (default SEND_CONFIRMATION_REFETCH_RETRY_MS). */
  retryDelayMs?: number
  /**
   * Runtime/currentness gate. Checked before each network attempt, after each
   * inter-attempt wait, and before materialization. When false, stop without
   * writing the captured store.
   */
  isCurrent?: () => boolean
}

function isConfirmationCurrent(isCurrent?: () => boolean): boolean {
  if (!isCurrent) return true
  try {
    return isCurrent() === true
  } catch {
    return false
  }
}

export async function fetchRecentSendConfirmationRecords(
  sessionId: string,
  messageID: string,
  directory?: string | null,
  options?: FetchRecentSendConfirmationOptions,
): Promise<Array<{ info: Message; parts?: Part[] }> | null> {
  const controller = options?.signal || options?.timeoutMs !== undefined ? new AbortController() : null
  const abortFromSignal = () => controller?.abort()
  options?.signal?.addEventListener("abort", abortFromSignal, { once: true })
  if (options?.signal?.aborted) controller?.abort()
  const timeout = options?.timeoutMs === undefined ? undefined : setTimeout(() => controller?.abort(), Math.max(0, options.timeoutMs))
  const attempts = options?.attempts ?? SEND_CONFIRMATION_REFETCH_ATTEMPTS
  const retryDelayMs = options?.retryDelayMs ?? SEND_CONFIRMATION_REFETCH_RETRY_MS
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (controller?.signal.aborted) return null
      if (!isConfirmationCurrent(options?.isCurrent)) return null
      if (attempt > 0) {
        await wait(retryDelayMs)
        if (controller?.signal.aborted) return null
        if (!isConfirmationCurrent(options?.isCurrent)) return null
      }
      try {
        const result = await sdk().session.messages({
          sessionID: sessionId,
          directory: directory ?? undefined,
          limit: getSendConfirmationRefetchLimit(),
          ...(controller ? { signal: controller.signal } : {}),
        } as Parameters<ReturnType<typeof sdk>["session"]["messages"]>[0] & { signal?: AbortSignal })
        if (!isConfirmationCurrent(options?.isCurrent)) return null
        const records = (assertSdkSuccess(result, "session.messages") ?? [])
          .filter((record: { info?: { id?: string } }) => !!record?.info?.id) as Array<{ info: Message; parts?: Part[] }>
        if (records.some((record) => record.info.id === messageID)) {
          return records
        }
      } catch {
        // Confirmation is best-effort; if it fails, keep the original send error path.
      }
    }
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
    options?.signal?.removeEventListener("abort", abortFromSignal)
  }
}

/**
 * Materialize authoritative send-confirmation records by message ID.
 * - Upserts every returned record by ID (recovery strategy) so optimistic
 *   shells are replaced and SSE-first rows are not duplicated.
 * - Other store messages outside the record set are preserved.
 * - Callers must not invoke this on fetch failure (null) — failure retains
 *   existing store content and never clears the transcript.
 *
 * `gapFillOnly` switches to `SEND_GAP_FILL_SESSION_MERGE_STRATEGY`: absent
 * messages are added and existing parts are left alone. Any caller that pulls
 * while live SSE may already own rows on the same page must set it, or an older
 * snapshot replays over live state.
 */
export function materializeConfirmedSendRecords(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  records: Array<{ info: Message; parts?: Part[] }>,
  options?: {
    gapFillOnly?: boolean
    /** Explicit directory for repository scope; defaults to current sync directory. */
    directory?: string
  },
): void {
  if (!records.length) return
  // messageID is the confirmation key used by callers; records must include it
  // (fetchRecentSendConfirmationRecords already gates on that).
  void messageID
  // Ensure the store identity is the live child store for this session so the
  // repository binding writes into the same map the caller captured.
  const directory = options?.directory ?? getSessionDirectory(sessionId) ?? _getDirectory()
  const scope = transcriptScope(directory, sessionId)
  const command = {
    type: "materialize-snapshots" as const,
    records: records.map((record) => ({
      info: stripMessageDiffSnapshots(record.info),
      parts: record.parts ?? [],
    })),
    skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS,
    // Default upserts so an optimistic/SSE shell for the same ID is replaced
    // by the authoritative snapshot without wiping sibling rows.
    merge: options?.gapFillOnly === true
      ? SEND_GAP_FILL_SESSION_MERGE_STRATEGY
      : resolveSessionMergeStrategy({ purpose: "recovery" }),
  }
  const applied = applyTranscriptCommand(scope, command)
  if (!applied) {
    resolveTranscriptRepositoryForStore(directory, store).apply(scope, command)
  }
}

/**
 * How long a confirmed send may stay absent from the store before it counts as
 * an anomaly. Purely local: SSE or the ordinary selection page fetch normally
 * lands well inside it, and the pending presentation covers the wait, so the
 * baseline send path issues no confirmation request at all.
 */
export const COMBINED_SEND_PRESENCE_GRACE_MS = 2_000

/** Anomaly-only recovery pull, entered solely after a real presence miss. */
export const COMBINED_SEND_CONFIRMATION_RECOVERY = {
  attempts: 12,
  retryDelayMs: 500,
} as const

/** Mutable options for combined send recovery (tests may shorten). */
export const combinedSendConfirmationOptions: {
  presenceGraceMs: number
  recovery: { attempts: number; retryDelayMs: number }
} = {
  presenceGraceMs: COMBINED_SEND_PRESENCE_GRACE_MS,
  recovery: { ...COMBINED_SEND_CONFIRMATION_RECOVERY },
}

/** Reset combined recovery options to production defaults (tests). */
export function resetCombinedSendConfirmationOptions(): void {
  combinedSendConfirmationOptions.presenceGraceMs = COMBINED_SEND_PRESENCE_GRACE_MS
  combinedSendConfirmationOptions.recovery = { ...COMBINED_SEND_CONFIRMATION_RECOVERY }
}

/**
 * Whether the repository holds a renderable `messageID` for the session.
 * Parts must be there too: a row whose parts never landed paints an empty
 * bubble, which is the same defect as the row being absent.
 */
function hasStoredSessionMessage(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  directory?: string | null,
): boolean {
  const resolvedDirectory = directory ?? getSessionDirectory(sessionId) ?? _getDirectory() ?? ""
  const repository = getTranscriptRepository()
    ?? resolveTranscriptRepositoryForStore(resolvedDirectory, store)
  const scope = transcriptScope(resolvedDirectory, sessionId)
  if (!repository.getMessage(scope, messageID)) return false
  return repository.getParts(scope, messageID).length > 0
}

/**
 * Local, request-free wait for a sent message to appear in the repository.
 * Resolves as soon as SSE or the ordinary selection page fetch delivers it, and
 * resolves false on timeout or once the caller's runtime is no longer current.
 */
function waitForStoredMessagePresence(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  options?: { timeoutMs?: number; isCurrent?: () => boolean; directory?: string | null },
): Promise<boolean> {
  const directory = options?.directory ?? getSessionDirectory(sessionId) ?? _getDirectory() ?? ""
  if (hasStoredSessionMessage(store, sessionId, messageID, directory)) return Promise.resolve(true)
  if (!isConfirmationCurrent(options?.isCurrent)) return Promise.resolve(false)
  const timeoutMs = options?.timeoutMs ?? COMBINED_SEND_PRESENCE_GRACE_MS
  return new Promise<boolean>((resolve) => {
    let settled = false
    // Object holder keeps teardown sync-safe if subscribe fires before assignment completes.
    const subscription: { unsubscribe?: () => void } = {}
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      subscription.unsubscribe?.()
      resolve(value)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    const repository = getTranscriptRepository()
      ?? resolveTranscriptRepositoryForStore(directory, store)
    const scope = transcriptScope(directory, sessionId)
    subscription.unsubscribe = repository.subscribe(scope, () => {
      if (!isConfirmationCurrent(options?.isCurrent)) {
        settle(false)
        return
      }
      if (hasStoredSessionMessage(store, sessionId, messageID, directory)) settle(true)
    })
    // subscribe() cannot observe a write that landed between the guard above and
    // the subscription itself, so re-check once the listener is installed.
    if (hasStoredSessionMessage(store, sessionId, messageID, directory)) settle(true)
  })
}

export type SentMessagePresenceOutcome = "present" | "recovered" | "missing" | "cancelled"

/**
 * Reactive send remediation: wait locally for the confirmed message to show up
 * and pull authoritative records ONLY when it never does. The happy path stays
 * exactly as request-free as before this remediation existed; a real presence
 * miss is the single trigger for one bounded recovery pull.
 *
 * The pull is gap-fill only: by then live SSE may own newer objects for sibling
 * rows on the same page, so it may add what is missing and nothing else.
 * Fetch → currentness recheck → gap-fill materialize is inlined here so a
 * runtime switch cannot write into a captured old store.
 */
export async function ensureSentUserMessagePresence(input: {
  store: DirectoryStoreApi
  sessionId: string
  messageID: string
  directory?: string | null
  isCurrent?: () => boolean
  graceMs?: number
}): Promise<SentMessagePresenceOutcome> {
  const { store, sessionId, messageID, directory, isCurrent } = input
  const present = await waitForStoredMessagePresence(store, sessionId, messageID, {
    timeoutMs: input.graceMs ?? combinedSendConfirmationOptions.presenceGraceMs,
    isCurrent,
    directory,
  })
  if (present) return "present"
  if (!isConfirmationCurrent(isCurrent)) return "cancelled"
  const records = await fetchRecentSendConfirmationRecords(sessionId, messageID, directory, {
    ...combinedSendConfirmationOptions.recovery,
    isCurrent,
  })
  if (!records) {
    return isConfirmationCurrent(isCurrent) ? "missing" : "cancelled"
  }
  // Second currentness gate: records may have arrived after a runtime switch.
  if (!isConfirmationCurrent(isCurrent)) return "cancelled"
  materializeConfirmedSendRecords(store, sessionId, messageID, records, {
    gapFillOnly: true,
    directory: directory ?? undefined,
  })
  return "recovered"
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  // The abort must carry the SESSION'S directory, not the active UI directory:
  // OpenCode routes the request to the per-directory instance, and an abort
  // sent to the wrong instance cancels nothing while still returning 200 true
  // (the "stop button does nothing" report — sessions in another project/
  // worktree than the UI's current directory could never be aborted).
  const { store, directory } = dirStoreForSession(sessionId)
  const scope = directory ? {
    state: "bound" as const,
    transportIdentity: getRuntimeTransportIdentity(),
    directory,
    sessionID: sessionId,
  } : null
  const blockToken = scope ? useSessionUIStore.getState().beginQueueAbortBlock(scope) : null
  try {
    const result = await sdk().session.abort({ sessionID: sessionId, directory })
    if (assertSdkData(result, "session.abort") !== true) {
      throw new Error("Session abort failed")
    }
    // A successful abort response is authoritative for this turn. Commit idle
    // locally as well as waiting for SSE so a newly materialized session cannot
    // remain stuck behind an optimistic busy state when its idle event raced
    // with selection/bootstrap. observed_at covers an incomplete aborted tail.
    const state = store.getState()
    store.setState({
      session_status: {
        ...state.session_status,
        [sessionId]: { type: "idle" as const },
      },
      session_status_observed_at: {
        ...state.session_status_observed_at,
        [sessionId]: Date.now(),
      },
    })
  } catch (error) {
    if (scope && blockToken) useSessionUIStore.getState().clearQueueAbortBlock(scope, blockToken)
    void import("./queue-abort-optimistic").then(({ rollbackQueueAbortOptimistic }) => {
      rollbackQueueAbortOptimistic(sessionId)
    }).catch(() => {})
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: response,
    ...(directory ? { directory } : {}),
  })
  if (assertSdkData(result, "permission.reply") !== true) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: "reject",
    ...(directory ? { directory } : {}),
  })
  if (assertSdkData(result, "permission.reply") !== true) {
    throw new Error("Permission dismissal failed")
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const normalizedAnswers = answers.length === 0
      ? []
      : Array.isArray(answers[0])
        ? answers as string[][]
        : [answers as string[]]
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reply({
      requestID: requestId,
      answers: normalizedAnswers,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reply") !== true) {
      throw new Error("Question reply failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

export async function rejectQuestion(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reject({
      requestID: requestId,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reject") !== true) {
      throw new Error("Question rejection failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/**
 * Dismiss every pending question for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a question prompt is open must cancel/supersede the
 * open question so it cannot linger or strand the session in a half-answered
 * state.
 *
 * The questions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `question.reject` round-trip. Each question is then formally rejected on the
 * backend, which fires `question.rejected` for reconciliation.
 *
 * Returns true when at least one question was dismissed. Rejection failures are
 * swallowed (a stranded question must never block the send);
 * QuestionNotFoundError also clears the stale entry from the child store via
 * {@link rejectQuestion}.
 *
 * NOTE: rejecting unblocks the agent's tool but does NOT end its turn. Callers
 * that need to send the next message right away (the chat send path) must also
 * abort the session so the OpenCode runner reaches `idle` — otherwise the new
 * prompt arrives while the run is still active and is discarded by the runner's
 * `ensureRunning`.
 */
export async function dismissOpenQuestionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const questionsBySession = state.question ?? {}
    for (const scopedId of scopedIds) {
      const requests = questionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the questions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removeQuestionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await rejectQuestion(scopedSessionId, requestId)
      } catch (error) {
        if (isQuestionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // question.asked / question.rejected event reconciles the store.
        console.error("[session-actions] Failed to dismiss open question on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Build a complete Composer restoration payload from target parts
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Commit the payload into the target DraftKey (CAS)
 * 5. Call the runtime revert endpoint; on failure roll back marker + draft
 *
 * Same-session revert/unrevert share a per-session serial flight so concurrent
 * HTTP cannot invert server marker order. Runtime-stale ops never publish.
 */
export type RevertedComposerSnapshot = ComposerRestorationPayload

export async function revertToMessage(
  sessionId: string,
  messageId: string,
  options?: string | {
    directory?: string
    /** When omitted, restores into the primary session DraftKey. Pass a DraftKey for surface isolation. */
    draftKey?: DraftKey | null
    /** @deprecated Prefer draftKey. When false and draftKey is omitted, skips draft restoration. */
    restorePrimaryInput?: boolean
  },
): Promise<RevertedComposerSnapshot> {
  const directoryOverride = typeof options === "string" ? options : options?.directory
  const explicitDraftKey = typeof options === "string" ? undefined : options?.draftKey
  const restorePrimaryInput = typeof options === "string" || options?.restorePrimaryInput !== false
  const shouldRestoreDraft = explicitDraftKey !== null && (explicitDraftKey !== undefined || restorePrimaryInput)

  // Resolve directory for the serial key before waiting; store reads happen after the flight starts.
  const directoryForKey = directoryOverride ?? (() => {
    try {
      return dirStoreForSession(sessionId, directoryOverride).directory
    } catch {
      return directoryOverride
    }
  })()

  return runSessionHistoryMutation(sessionId, directoryForKey, async ({ isCurrent }) => {
    // Read current store state after the queue wait so a concurrent op cannot leave us with a stale snapshot.
    const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
    if (!isCurrent()) {
      throw new Error("Session history mutation aborted because the runtime changed")
    }
    const state = store.getState()

    // Abort if busy before mutating session state
    const status = state.session_status[sessionId]
    if (status && status.type !== "idle") {
      try {
        await sdk().session.abort({ sessionID: sessionId, directory })
      } catch {
        // ignore abort errors
      }
      if (!isCurrent()) {
        throw new Error("Session history mutation aborted because the runtime changed")
      }
    }

    // Ticket 09 batch 1B: target message/parts from TranscriptRepository.
    const messages = readSessionMessages(sessionId, directory)
    const targetMsg = messages.find((m) => m.id === messageId)
    // Fail before mutating marker/draft/API when the target user message is missing.
    // Re-read after abort awaits in case another mutation changed the transcript.
    const liveMessages = readSessionMessages(sessionId, directory)
    const liveTarget = liveMessages.find((m) => m.id === messageId) ?? targetMsg
    if (!liveTarget || liveTarget.role !== "user") {
      throw new Error("The selected user message is unavailable")
    }
    const { repository, directory: transcriptDirectory } = transcriptRepositoryForSession(sessionId, directory)
    let targetParts = [...repository.getParts(
      transcriptScope(transcriptDirectory, sessionId),
      messageId,
    )] as unknown as Array<Record<string, unknown>>

    const targetDraftKey = explicitDraftKey === undefined
      ? (shouldRestoreDraft
        ? sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, sessionId)
        : null)
      : explicitDraftKey

    let restoration: RevertedComposerSnapshot = {
      snapshot: { text: "", attachments: [], syntheticParts: [], mentions: [] },
      values: new Map(),
    }
    let restoredRevision: number | undefined
    let previousDraft: Awaited<ReturnType<typeof commitComposerRestoration>>["previous"]

    if (targetDraftKey) {
      try {
        targetParts = await ensureSentMessagePartsForComposerRestoration({
          directory: transcriptDirectory,
          sessionID: sessionId,
          messageID: messageId,
          parts: targetParts,
          isCurrent,
        })
        restoration = await buildSentMessageComposerRestoration(targetParts, {
          sessionTitles: sessionTitlesForRestoration(),
          directory,
        })
      } catch (error) {
        if (
          error instanceof Error
          && (
            error.message.startsWith("composer-restoration-materialize-failed")
            || error.message === "composer-restoration-incomplete-attachment"
            || error.message.includes("runtime changed")
          )
        ) {
          throw error
        }
        // Invalid payload must not overwrite the live draft.
        throw new Error("composer-restoration-invalid-payload")
      }
      if (!isCurrent()) {
        throw new Error("Session history mutation aborted because the runtime changed")
      }
    }

    // Optimistically set only the revert marker. Keep messages and parts in the
    // local store; visible-message selectors derive the displayed timeline from
    // session.revert. This matches the server model and preserves reverted
    // messages for the restore dock without maintaining a separate shadow copy.
    const liveState = store.getState()
    const prevRevert = (() => {
      const s = liveState.session.find((s) => s.id === sessionId)
      return (s as Session & { revert?: unknown })?.revert
    })()
    const sessions = [...liveState.session]
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

    const patch: Record<string, unknown> = {}

    if (sessionIdx >= 0) {
      sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
      patch.session = sessions
    }

    if (!isCurrent()) {
      throw new Error("Session history mutation aborted because the runtime changed")
    }
    store.setState(patch)

    if (targetDraftKey) {
      const input = useInputStore.getState()
      const current = input.getDraft(targetDraftKey)
      const committed = await commitComposerRestoration({
        key: targetDraftKey,
        expectedRevision: current?.revision ?? "absent",
        payload: restoration,
        runtime: input.captureDraftRuntime(),
      })
      if (!isCurrent()) {
        // Stale runtime: roll back marker if we wrote it; do not leave foreign marker.
        const currentState = store.getState()
        const rollback = [...currentState.session]
        const idx = rollback.findIndex((s) => s.id === sessionId)
        if (idx >= 0) {
          rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
        }
        store.setState({ session: rollback })
        if (committed.status === "committed" && committed.current && committed.previous && committed.result?.record?.revision !== undefined) {
          await rollbackComposerRestoration({
            key: targetDraftKey,
            restoredRevision: committed.result.record.revision,
            previous: committed.previous,
          }).catch(() => undefined)
        }
        throw new Error("Session history mutation aborted because the runtime changed")
      }
      previousDraft = committed.previous
      // User-facing restore requires a current committed memory snapshot (not durable-stale alone).
      if (committed.status !== "committed" || !committed.current) {
        // Roll back marker only; leave the live draft untouched.
        const currentState = store.getState()
        const rollback = [...currentState.session]
        const idx = rollback.findIndex((s) => s.id === sessionId)
        if (idx >= 0) {
          rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
        }
        store.setState({ session: rollback })
        throw new Error(`composer-restoration-commit-${committed.status}`)
      }
      restoredRevision = committed.result?.record?.revision
    }

    // Call SDK and merge authoritative result into store
    try {
      const revertedSession = await opencodeClient.revertSession(sessionId, messageId, undefined, directory)
      if (!isCurrent()) {
        // Stale runtime must not leave its optimistic marker or adopt the remote session.
        const stale = store.getState()
        const rollback = [...stale.session]
        const rollbackIdx = rollback.findIndex((s) => s.id === sessionId)
        if (rollbackIdx >= 0) {
          rollback[rollbackIdx] = { ...rollback[rollbackIdx], revert: prevRevert } as Session
        }
        store.setState({ session: rollback })
        if (targetDraftKey && previousDraft && restoredRevision !== undefined) {
          await rollbackComposerRestoration({
            key: targetDraftKey,
            restoredRevision,
            previous: previousDraft,
          }).catch(() => undefined)
        }
        throw new Error("Session history mutation aborted because the runtime changed")
      }
      const current = store.getState()
      const updated = [...current.session]
      const idx = updated.findIndex((s) => s.id === sessionId)
      if (idx >= 0) {
        updated[idx] = revertedSession
        store.setState({ session: updated })
      }
      if (directory) {
        sessionEvents.requestGitRefresh({ directory })
      }
      return restoration
    } catch (err) {
      // Rollback: restore revert marker (including after remote failure under a still-current runtime).
      const current = store.getState()
      const rollback = [...current.session]
      const idx = rollback.findIndex((s) => s.id === sessionId)
      if (idx >= 0) {
        rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
      }
      if (isCurrent()) {
        store.setState({
          session: rollback,
        })
        // CAS-restore the previous full draft when the user has not continued editing.
        if (targetDraftKey && previousDraft && restoredRevision !== undefined) {
          await rollbackComposerRestoration({
            key: targetDraftKey,
            restoredRevision,
            previous: previousDraft,
          })
        }
      } else if (!(err instanceof Error && err.message.includes("runtime changed"))) {
        // Runtime switched mid-failure (not already handled above): undo our optimistic local write.
        store.setState({ session: rollback })
        if (targetDraftKey && previousDraft && restoredRevision !== undefined) {
          await rollbackComposerRestoration({
            key: targetDraftKey,
            restoredRevision,
            previous: previousDraft,
          }).catch(() => undefined)
        }
      }
      throw err
    }
  })
}

function removeSessionMessageFromStore(
  store: DirectoryStoreApi,
  sessionId: string,
  messageId: string,
  directory?: string,
): void {
  const resolvedDirectory = directory ?? getSessionDirectory(sessionId) ?? _getDirectory()
  const resolvedScope = transcriptScope(resolvedDirectory, sessionId)
  const deleteDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(sessionId, resolvedDirectory).data,
  )
  const scopes = [...listCanonicalTranscriptScopes(sessionId)]
  if (!scopes.some((scope) => scope.directory === resolvedDirectory && scope.sessionID === sessionId)) {
    scopes.push(resolvedScope)
  }
  let boundApplied = false
  for (const scope of scopes) {
    const applied = applyTranscriptCommand(scope, {
      type: "remove-message",
      messageID: messageId,
    })
    if (applied != null) boundApplied = true
  }
  // Store-adapter fallback is only needed for the resolved directory when the
  // production repository is unbound (unit tests without a Query bind).
  if (!boundApplied) {
    resolveTranscriptRepositoryForStore(resolvedDirectory, store).apply(resolvedScope, {
      type: "remove-message",
      messageID: messageId,
    })
  }
  const deleteDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(sessionId, resolvedDirectory).data,
  )
  try {
    if (deleteDiffBefore && deleteDiffAfter) {
      recordTranscriptDiff({
        trigger: "user-delete",
        sessionID: sessionId,
        directory: resolvedDirectory,
        transport: getRuntimeTransportIdentity(),
        generation: getRuntimeGeneration(),
        before: deleteDiffBefore,
        after: deleteDiffAfter,
      })
    }
  } catch {
    // Diagnostics must never affect message removal.
  }
}

export type StageMessageEditOptions = {
  /** Explicit directory for the correct child store and file-mention relativization. */
  directory?: string
  /**
   * Target draft partition. Defaults to the primary `sessionDraftKey` for this session.
   * Assistant continuous edit passes a `surfaceDraftKey` so primary drafts stay untouched.
   */
  draftKey?: DraftKey
}

/**
 * Opaque handle for rolling back a staged message-edit draft restore.
 * Primary callers may ignore the return value; Assistant uses rollback when
 * binding/runtime is stale after the async stage completes.
 */
export type StageMessageEditHandle = {
  /**
   * CAS-rollback the draft to the pre-stage record (or true absence).
   * Conflict means the user continued editing — keep their newer revision.
   * Deferred cross-runtime rollback (status failed + deferred) is mapped to
   * failed so Assistant StageHandle retains protection; the intent retries later.
   */
  rollback: () => Promise<{ status: "rolled-back" | "conflict" | "failed" | "skipped" }>
}

export async function stageMessageEdit(
  sessionId: string,
  messageId: string,
  snapshot?: MessageEditSnapshot,
  options?: StageMessageEditOptions,
): Promise<StageMessageEditHandle> {
  let targetMessage = snapshot?.info
  let targetParts = snapshot?.parts
  const directoryOverride = options?.directory
  let directory: string | undefined

  if (snapshot) {
    const visibleMessage = snapshot.info
    if (
      visibleMessage.id !== messageId
      || visibleMessage.sessionID !== sessionId
      || visibleMessage.role !== "user"
    ) {
      throw new Error("The selected user message is unavailable")
    }
    directory = dirStoreForSession(sessionId, directoryOverride).directory
  } else {
    const resolved = dirStoreForSession(sessionId, directoryOverride)
    directory = resolved.directory
    const { data } = readSessionTranscript(sessionId, directory)
    const messages = messagesFromTranscriptData(data)
    const targetIndex = messages.findIndex((message) => message.id === messageId)
    const storedMessage = targetIndex >= 0 ? messages[targetIndex] : undefined
    if (!storedMessage || storedMessage.role !== "user") {
      throw new Error("The selected user message is unavailable")
    }
    targetMessage = storedMessage
    // Keep missing part-key semantics for user messages (do not coerce to []).
    // Repository partsByMessageID: absent key → undefined; present [] → [].
    targetParts = Object.prototype.hasOwnProperty.call(data.partsByMessageID, messageId)
      ? [...(data.partsByMessageID[messageId] ?? [])]
      : undefined
  }

  if (!targetMessage) {
    throw new Error("The selected user message is unavailable")
  }
  // Snapshot/store without a part key still stages an empty composer draft;
  // we must not invent a `[]` part key back into the message store here.
  if (snapshot && targetParts === undefined) {
    throw new Error("The selected user message is unavailable")
  }

  const key = options?.draftKey
    ?? sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, sessionId)
  const restoredParts = await ensureSentMessagePartsForComposerRestoration({
    directory,
    sessionID: sessionId,
    messageID: messageId,
    parts: (targetParts ?? []) as Array<Record<string, unknown>>,
  })
  const { commit } = await commitSentPartsToDraftKey({
    key,
    parts: restoredParts,
    directory,
  })
  if (commit.status !== "committed" || !commit.current) {
    throw new Error(`composer-restoration-commit-${commit.status}`)
  }
  const restoredRevision = commit.result?.record?.revision
  const previous = commit.previous
  if (restoredRevision === undefined || !previous) {
    // Committed without rollback material — noop handle (should not happen for durable commits).
    return { rollback: async () => ({ status: "skipped" as const }) }
  }
  return {
    rollback: async () => {
      const rolled = await rollbackComposerRestoration({
        key,
        restoredRevision,
        previous,
      })
      return { status: rolled.status }
    },
  }
}

/**
 * Resolve the delete range for an edit commit from live conversation order.
 * `conversation` is transcript `messageOrder` (oldest → newest) — never
 * re-sorted by id. Forward means "at or after the target in that array".
 * Only server-known ids are candidates, so an optimistic row is never deleted.
 * When a replacement id is known, the tail stops at that conversation
 * position so the echoed resend (and anything after it) is kept.
 */
function resolveMessageEditDeleteRange(
  messageId: string,
  conversation: readonly Message[],
  serverKnownIds: ReadonlySet<string>,
  options?: { preserveMessageId?: string },
): Message[] {
  const targetIndex = conversation.findIndex((message) => message.id === messageId)
  const targetMessage = targetIndex >= 0 ? conversation[targetIndex] : undefined
  if (!targetMessage || targetMessage.role !== "user" || !serverKnownIds.has(messageId)) {
    throw new Error("The selected user message is unavailable")
  }

  const preserveMessageId = options?.preserveMessageId
  const preserveIndex = preserveMessageId
    ? conversation.findIndex((message) => message.id === preserveMessageId)
    : -1
  const end = preserveIndex > targetIndex ? preserveIndex : conversation.length
  return conversation
    .slice(targetIndex, end)
    .filter((message) => {
      if (!serverKnownIds.has(message.id)) return false
      if (preserveMessageId && message.id === preserveMessageId) return false
      return true
    })
}

/**
 * Abort a still-busy session before an edit replacement is dispatched.
 * OpenCode rejects deleteMessage while the session is busy (HTTP 409), so callers
 * must wait for idle after abort before deleting the old tail.
 */
export async function abortBusySessionForMessageEdit(
  sessionId: string,
  options?: { directory?: string },
): Promise<void> {
  const directoryOverride = options?.directory
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  const status = store.getState().session_status[sessionId]
  if (!status || status.type === "idle") return
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch {
    // ignore abort errors — waitForSessionIdle still observes the live status
  }
}

/**
 * Wait until the session reports idle (or has no status entry).
 * Used after abort so deleteMessage is not rejected with "Session is busy".
 * The composer keeps `messageEditCommitting` painted while this wait runs.
 */
export async function waitForSessionIdleForMessageEdit(
  sessionId: string,
  options?: { directory?: string; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const directoryOverride = options?.directory
  const timeoutMs = options?.timeoutMs ?? 15_000
  const intervalMs = options?.intervalMs ?? 100
  const { store } = dirStoreForSession(sessionId, directoryOverride)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const status = store.getState().session_status[sessionId]
    if (!status || status.type === "idle") return
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }

  const status = store.getState().session_status[sessionId]
  if (!status || status.type === "idle") return
  throw new Error(`Session is still busy after waiting to edit: ${sessionId}`)
}

/**
 * Commit a staged message edit before its replacement send.
 * Order required by OpenCode: abort (if busy) → wait idle → delete old tail → send.
 * The official delete-message endpoint removes conversation data only, so the
 * action deletes the target turn and every later conversation-order message
 * while retaining files — except a preserved replacement id and anything after
 * it in `messageOrder` (safety for an already-echoed in-flight row).
 *
 * Local rows are dropped one by one as their remote delete succeeds — nothing is
 * hidden up front. The composer paints an "editing" affordance on the target
 * while abort/wait/delete run. The server snapshot is membership-only and is
 * not materialized, so a windowed or id-sorted refetch cannot rewrite the
 * visible timeline.
 */
export async function commitMessageEdit(
  sessionId: string,
  messageId: string,
  options?: { directory?: string; preserveMessageId?: string },
): Promise<void> {
  const directoryOverride = options?.directory
  const preserveMessageId = options?.preserveMessageId
    ?? useSessionUIStore.getState().pendingSendMessageIDs.get(sessionId)
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  const editDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(sessionId, directoryOverride).data,
  )

  try {
    await abortBusySessionForMessageEdit(sessionId, { directory: directoryOverride })
    await waitForSessionIdleForMessageEdit(sessionId, { directory: directoryOverride })

    const serverKnownIds = new Set(
      (await fetchSessionMessageSnapshot(sessionId, directoryOverride)).map((message) => message.id),
    )
    // Read order after the snapshot await so abort/SSE rows that landed during
    // the membership fetch are included in the conversation tail.
    const conversation = readSessionMessages(sessionId, directoryOverride)
    const removedMessages = resolveMessageEditDeleteRange(messageId, conversation, serverKnownIds, {
      preserveMessageId,
    })

    for (const message of [...removedMessages].reverse()) {
      await opencodeClient.deleteSessionMessage(sessionId, message.id, directory)
      removeSessionMessageFromStore(store, sessionId, message.id, directory)
    }
  } finally {
    try {
      const editDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() =>
        readSessionTranscript(sessionId, directoryOverride).data,
      )
      if (editDiffBefore && editDiffAfter) {
        recordTranscriptDiff({
          trigger: "user-edit",
          sessionID: sessionId,
          directory,
          transport: getRuntimeTransportIdentity(),
          generation: getRuntimeGeneration(),
          before: editDiffBefore,
          after: editDiffAfter,
        })
      }
    } catch {
      // Diagnostics must never affect message edit.
    }
  }
}

/** Server membership snapshot — does not rewrite the live transcript. */
async function fetchSessionMessageSnapshot(sessionId: string, directoryOverride?: string): Promise<Message[]> {
  const { directory } = dirStoreForSession(sessionId, directoryOverride)
  const result = await sdk().session.messages({
    sessionID: sessionId,
    directory,
    limit: getMessageRefetchLimit(),
  })
  const records = (assertSdkSuccess(result, "session.messages") ?? [])
    .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  return records.map((record: { info: Message }) => stripMessageDiffSnapshots(record.info))
}

/** Resolves to the authoritative snapshot this refetch materialized. */
export async function refetchSessionMessages(sessionId: string, directoryOverride?: string): Promise<Message[]> {
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  const refetchDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
    readSessionTranscript(sessionId, directoryOverride).data,
  )
  const result = await sdk().session.messages({
    sessionID: sessionId,
    directory,
    limit: getMessageRefetchLimit(),
  })
  const records = (assertSdkSuccess(result, "session.messages") ?? [])
    .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  if (records.length === 0) {
    try {
      const emptyAfter = tryCaptureTranscriptCanonicalSnapshot(() =>
        readSessionTranscript(sessionId, directoryOverride).data,
      )
      if (refetchDiffBefore && emptyAfter) {
        recordTranscriptDiff({
          trigger: "materialize",
          sessionID: sessionId,
          directory,
          transport: getRuntimeTransportIdentity(),
          generation: getRuntimeGeneration(),
          purpose: "refetch",
          before: refetchDiffBefore,
          after: emptyAfter,
        })
      }
    } catch {
      // Diagnostics must never affect refetch.
    }
    return []
  }

  const snapshots = records.map((record: { info: Message; parts?: Part[] }) => ({
    info: stripMessageDiffSnapshots(record.info),
    parts: record.parts ?? [],
  }))

  // Ticket 03/09: revert/redo refetch materializes through TranscriptRepository.
  void store
  const scope = transcriptScope(directory ?? _getDirectory(), sessionId)
  const applied = applyTranscriptCommand(scope, {
    type: "materialize-snapshots",
    records: snapshots,
    skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS,
  })
  if (!applied) {
    // Tests without production bind: apply via store-scoped repository.
    resolveTranscriptRepositoryForStore(directory ?? _getDirectory(), store).apply(scope, {
      type: "materialize-snapshots",
      records: snapshots,
      skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS,
    })
  }

  try {
    const refetchDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() =>
      readSessionTranscript(sessionId, directoryOverride).data,
    )
    if (refetchDiffBefore && refetchDiffAfter) {
      recordTranscriptDiff({
        trigger: "materialize",
        sessionID: sessionId,
        directory,
        transport: getRuntimeTransportIdentity(),
        generation: getRuntimeGeneration(),
        purpose: "refetch",
        before: refetchDiffBefore,
        after: refetchDiffAfter,
      })
    }
  } catch {
    // Diagnostics must never affect refetch.
  }

  return snapshots.map((snapshot: { info: Message }) => snapshot.info)
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 * Shares the per-session history mutation serial flight with revertToMessage.
 */
export async function unrevertSession(sessionId: string, directoryOverride?: string): Promise<void> {
  const directoryForKey = directoryOverride ?? (() => {
    try {
      return dirStoreForSession(sessionId, directoryOverride).directory
    } catch {
      return directoryOverride
    }
  })()

  return runSessionHistoryMutation(sessionId, directoryForKey, async ({ isCurrent }) => {
    const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
    if (!isCurrent()) {
      throw new Error("Session history mutation aborted because the runtime changed")
    }
    const state = store.getState()
    const previousMessageCount = readSessionMessageCount(sessionId, directory)

    // Abort if busy
    const status = state.session_status[sessionId]
    if (status && status.type !== "idle") {
      try {
        await sdk().session.abort({ sessionID: sessionId, directory })
      } catch {
        // ignore
      }
      if (!isCurrent()) {
        throw new Error("Session history mutation aborted because the runtime changed")
      }
    }

    const result = await sdk().session.unrevert({ sessionID: sessionId, directory })
    if (!isCurrent()) {
      throw new Error("Session history mutation aborted because the runtime changed")
    }
    const unrevertedSession = assertSdkData(result, "session.unrevert")
    const current = store.getState()
    const sessions = [...current.session]
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      sessions[idx] = unrevertedSession
      store.setState({ session: sessions })
    }
    for (let attempt = 0; attempt < UNREVERT_REFETCH_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await wait(UNREVERT_REFETCH_RETRY_MS)
        if (!isCurrent()) {
          throw new Error("Session history mutation aborted because the runtime changed")
        }
      }
      await refetchSessionMessages(sessionId, directoryOverride)
      if (!isCurrent()) {
        throw new Error("Session history mutation aborted because the runtime changed")
      }
      const nextMessageCount = readSessionMessageCount(sessionId, directory)
      if (nextMessageCount > previousMessageCount) return
    }

    // Ticket 09 batch 1B: after unrevert, destructiveReset+ensure when count
    // did not grow (stale Query pages). Failure propagates so UI can retry.
    if (readSessionMessageCount(sessionId, directory) <= previousMessageCount) {
      const resolvedDirectory = directory ?? _getDirectory()
      const repository = (getTranscriptRepository()
        ?? resolveTranscriptRepositoryForStore(resolvedDirectory, store)) as TranscriptRepository & {
        destructiveReset?: (scope: import("./transcript-repository").TranscriptScope) => Promise<unknown>
      }
      const scope = transcriptScope(resolvedDirectory, sessionId)
      if (typeof repository.destructiveReset === "function") {
        await repository.destructiveReset(scope)
      } else {
        await refetchSessionMessages(sessionId, directoryOverride)
      }
    }
  })
}

/**
 * Fork from a message or the latest stable conversation turn.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call the runtime fork endpoint
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. As soon as OpenCode returns the forked session id, bind the loading
 *    shell to that session and switch the route. Transcript reset/load
 *    continues on the new conversation; the source stays operable if the
 *    user navigates back.
 * 5. Restore pending input only while still viewing the fork
 */
export async function forkSession(sessionId: string, operationId: number, messageId?: string, directoryOverride?: string): Promise<boolean> {
  const forkRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  if (!directory) throw new Error("Fork session directory is unavailable")
  const sourceSession = await ensureForkSourceSession(sessionId, store, directory)
  registerSessionDirectory(sessionId, directory)
  let state = store.getState()

  let sourceStatus = state.session_status[sessionId]
  // Ticket 09 batch 1B: fork source messages/parts from TranscriptRepository.
  let sourceMessages = readSessionMessages(sessionId, directory)
  console.info("[session-fork] resolving fork point", {
    operationId,
    sessionId,
    requestedMessageId: messageId ?? null,
    statusType: sourceStatus?.type ?? "unknown",
    messageCount: sourceMessages.length,
  })
  let forkMessageId = resolveForkMessageId(messageId, sourceMessages, sourceStatus)
  if (!messageId && needsLiveUserForkPoint(sourceStatus, sourceMessages) && lastUserMessageIndex(sourceMessages) === -1) {
    console.info("[session-fork] refreshing messages to resolve the active fork point", {
      operationId,
      sessionId,
    })
    await refetchSessionMessages(sessionId)
    state = store.getState()
    sourceStatus = state.session_status[sessionId]
    sourceMessages = readSessionMessages(sessionId, directory)
    forkMessageId = resolveForkMessageId(undefined, sourceMessages, sourceStatus)
  }
  if (!messageId && needsLiveUserForkPoint(sourceStatus, sourceMessages) && lastUserMessageIndex(sourceMessages) === -1) {
    console.error("[session-fork] active session has no user message fork point", {
      operationId,
      sessionId,
      statusType: state.session_status[sessionId]?.type ?? "unknown",
      messageCount: readSessionMessageCount(sessionId, directory),
    })
    throw new Error("Fork source user message is unavailable")
  }
  console.info("[session-fork] fork point resolved", {
    operationId,
    sessionId,
    forkMessageId: forkMessageId ?? null,
    statusType: state.session_status[sessionId]?.type ?? "unknown",
  })

  // Extract message text and file attachments for input restoration.
  // Only restore the composer when forking from a user message — assistant
  // forks keep conversation context but should not dump model output into input.
  // Only non-synthetic text parts — the server adds file content as synthetic
  // text parts that should not be restored. File parts (images, pasted
  // screenshots) are user-originated and must be restored.
  const { repository: forkRepo, data: forkData } = readSessionTranscript(sessionId, directory)
  const forkSourceMessage = messageId
    ? forkData.messagesByID[messageId] ?? sourceMessages.find((message) => message.id === messageId)
    : undefined
  const shouldRestoreComposer = forkSourceMessage?.role === "user"
  const parts = shouldRestoreComposer && messageId
    ? [...forkRepo.getParts(transcriptScope(directory, sessionId), messageId)]
    : []
  let messageText = ""
  const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
  messageText = textParts
    .map((p: Part) => ((p as Record<string, unknown>).text as string) || ((p as Record<string, unknown>).content as string) || "")
    .join("\n")
    .trim()
  const fileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>

  activeForkCopy = {
    operationId,
    runtimeKey: forkRuntimeKey,
    directory,
    sourceSessionID: sessionId,
    expectedTargetTitle: getForkedSessionTitle(sourceSession.title),
  }
  // Long sessions spend most of the wait here (server-side clone).
  await setForkTransitionStage(operationId, "copying")

  let forkedSession: Session
  try {
    console.info("[session-fork] calling runtime fork endpoint", {
      operationId,
      sessionId,
      forkMessageId: forkMessageId ?? null,
    })
    forkedSession = await opencodeClient.forkSession(sessionId, forkMessageId, directory)
    console.info("[session-fork] runtime fork endpoint returned", {
      operationId,
      sessionId,
      forkedSessionId: forkedSession.id,
    })
    if (getRuntimeKey() !== forkRuntimeKey) {
      console.warn("[session-fork] runtime changed while fork was in progress", {
        operationId,
        sessionId,
        forkedSessionId: forkedSession.id,
      })
      if (activeForkCopy?.operationId === operationId) activeForkCopy = null
      return false
    }

    // Sidebar + route first: the loading shell binds to this id so the source
    // chat is operable again if the user navigates back during reset/load.
    const current = store.getState()
    const sessions = [...current.session]
    const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
    if (!searchResult.found) {
      sessions.splice(searchResult.index, 0, forkedSession)
      store.setState({ session: sessions })
    }
    setForkTransitionTarget(operationId, forkedSession.id)
    const viewingSessionId = useSessionUIStore.getState().currentSessionId
    const shouldFollowFork =
      viewingSessionId === sessionId || viewingSessionId === forkedSession.id
    if (shouldFollowFork) {
      useSessionUIStore.getState().setCurrentSession(forkedSession.id, directory, {
        skipMessageFetch: true,
      })
    }
    await setForkTransitionStage(operationId, "opening")
    try {
      forkedSession = await markForkSessionAsLatest(forkedSession, directory)
    } catch (error) {
      console.warn("[session-actions] failed to promote forked session", error)
    }
  } catch (error) {
    if (activeForkCopy?.operationId === operationId) activeForkCopy = null
    throw error
  }

  try {
    // Fork emits every cloned message and part over SSE. Discard any target
    // transcript that raced into Query so selection follows the regular
    // bounded tail load. Prefer Query destructiveReset (purge+ensure); fall
    // back to narrow reset + fetchMessagesForSession when unbound (tests).
    const forkTargetScope = transcriptScope(directory, forkedSession.id)
    const boundRepo = getTranscriptRepository() as
      | (TranscriptRepository & {
        destructiveReset?: (scope: import("./transcript-repository").TranscriptScope) => Promise<unknown>
      })
      | null
    if (boundRepo && typeof boundRepo.destructiveReset === "function") {
      await boundRepo.destructiveReset(forkTargetScope)
    } else {
      applyTranscriptCommand(forkTargetScope, { type: "reset" })
    }

    await setForkTransitionStage(operationId, "loading")
    console.info("[session-fork] loading the forked session", {
      operationId,
      sessionId,
      forkedSessionId: forkedSession.id,
      followed: useSessionUIStore.getState().currentSessionId === forkedSession.id,
    })
    // When destructiveReset already ensured a tail, skip redundant initial fetch
    // unless the repository still reports unknown / error.
    const afterReset = getTranscriptRepository()
      ?? resolveTranscriptRepositoryForStore(directory, store)
    const afterScope = transcriptScope(directory, forkedSession.id)
    const afterRequest = afterReset.getRequestState?.(afterScope)
    if (
      !(afterReset.hasSession?.(afterScope) ?? false)
      || afterRequest?.status === "error"
    ) {
      await fetchMessagesForSession(forkedSession.id, directory)
    }
    const loadedMessages = readSessionMessages(forkedSession.id, directory)
    const newestLoadedMessageID = loadedMessages.at(-1)?.id
    if (newestLoadedMessageID) {
      forkCopyEventCutoffs.set(`${getRuntimeKey()}:${directory}:${forkedSession.id}`, {
        messageID: newestLoadedMessageID,
        expiresAt: Date.now() + FORK_COPY_EVENT_CUTOFF_TTL_MS,
      })
    }

    // Restore forked message text and file attachments to input (user messages only).
    // Skip when the user left the fork path — pendingInput is a global one-shot.
    const viewingForkedSession = useSessionUIStore.getState().currentSessionId === forkedSession.id
    if (viewingForkedSession && shouldRestoreComposer && messageText) {
      useInputStore.setState({
        pendingInputText: messageText,
        pendingInputMode: "replace" as const,
      })
    }
    // A selected message owns its attachment restoration snapshot. A current-session
    // fork preserves the composer's existing resources.
    if (viewingForkedSession && shouldRestoreComposer && messageId) restoreFilePartsToInput(fileParts)
  } finally {
    if (activeForkCopy?.operationId === operationId) activeForkCopy = null
  }
  console.info("[session-fork] forked session is ready", {
    operationId,
    sessionId,
    forkedSessionId: forkedSession.id,
  })
  return true
}

// ---------------------------------------------------------------------------
// Imperative fetch path — starts message loading on the same tick as
// setCurrentSession, before the React commit cycle fires useEffect.
// ---------------------------------------------------------------------------

const FETCH_MESSAGES_LOADING = new Map<string, Promise<void>>()

export async function fetchMessagesForSession(
  sessionID: string,
  directory?: string | null,
): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return

  const runtimeKey = getRuntimeKey()
  const limit = getInitialSessionMessageLimit()
  const loadingKey = `${runtimeKey}:${resolvedDir}:${sessionID}:${limit}`
  if (!_sdk || !_childStores) {
    PENDING_MESSAGE_FETCHES.set(loadingKey, { sessionID, directory: resolvedDir })
    return
  }

  // Single-flight ordinary loads for the same scope.
  const existingRequest = FETCH_MESSAGES_LOADING.get(loadingKey)
  if (existingRequest) return existingRequest

  const request = fetchMessagesForSessionInternal(sessionID, resolvedDir, runtimeKey, limit)
  const trackedRequest = request.finally(() => {
    if (FETCH_MESSAGES_LOADING.get(loadingKey) === trackedRequest) {
      FETCH_MESSAGES_LOADING.delete(loadingKey)
    }
  })
  FETCH_MESSAGES_LOADING.set(loadingKey, trackedRequest)
  return trackedRequest
}

async function fetchMessagesForSessionInternal(
  sessionID: string,
  resolvedDir: string,
  runtimeKey: string,
  limit: number,
): Promise<void> {
  const s = sdk()
  const store = dirStoreForDirectory(resolvedDir)

  const cachedState = store.getState()
  const statusBeforePull = cachedState.session_status?.[sessionID]
  const statusObservedAtBeforePull = cachedState.session_status_observed_at?.[sessionID]
  // Ticket 09: cache reuse from repository (Query when bound; store adapter in tests).
  const repository = getTranscriptRepository()
    ?? resolveTranscriptRepositoryForStore(resolvedDir, store)
  const scope = transcriptScope(resolvedDir, sessionID)
  const transcript = repository.getTranscript(scope)
  const pagination = repository.getPagination(scope)
  const request = repository.getRequestState?.(scope)
  const isUserRole = (message: Message) =>
    message.role === "user" || (message as Message & { clientRole?: string }).clientRole === "user"
  const cachedMessages = transcript.messageOrder
    .map((id) => transcript.messagesByID[id])
    .filter((message): message is Message => Boolean(message))
  const hasUserBoundary = cachedMessages.some(isUserRole)
  const boundary = pagination.boundary
  const hasKnownBoundary = boundary.kind === "has-more" || boundary.kind === "exhausted"
  const hasHotCache = (
    (repository.hasSession?.(scope) ?? cachedMessages.length > 0)
    && (hasUserBoundary || boundary.kind === "exhausted")
    && hasKnownBoundary
    && request?.status !== "error"
  )
  // Ticket 09: selection materialize — raw Host turn-page → repository http-page.
  // Bound Query in production; store adapter when tests leave production unbound.
  // Staleness guard: skip side effects after a session switch mid-flight.
  const isStale = () => useSessionUIStore.getState().currentSessionId !== sessionID
  if (hasHotCache) {
    if (isSessionAuthorityRevalidateFresh(resolvedDir, sessionID)) {
      seedSessionTodosFromHydratedTranscript({
        directory: resolvedDir,
        sessionID,
        store,
        transcript,
      })
      return
    }
    // Production enter path: light authority check via ensureInitial
    // (reconcile-page). Store-adapter tests keep the prior short-circuit.
    if (getTranscriptRepository()) {
      try {
        await ensureTranscriptInitial(resolvedDir, sessionID)
      } catch {
        return
      }
      if (isStale()) return
      seedSessionTodosFromHydratedTranscript({
        directory: resolvedDir,
        sessionID,
        store,
        isStale,
      })
      await reconcileActiveSessionStatusAfterMessagePull({
        directory: resolvedDir,
        sessionID,
        store,
        statusBeforePull,
        statusObservedAtBeforePull,
        hasMessages: (repository.getTranscript(scope).messageOrder.length) > 0,
      })
      return
    }
    seedSessionTodosFromHydratedTranscript({
      directory: resolvedDir,
      sessionID,
      store,
      transcript,
    })
    return
  }

  void runtimeKey
  void s

  let recordCount = 0
  try {
    const page = await fetchProductionTranscriptTransportPage({
      directory: resolvedDir,
      sessionID,
      limit,
      signal: AbortSignal.timeout(30_000),
      purpose: "initial",
    })
    if (isStale()) return
    repository.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page,
      skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS,
    })
    recordCount = page.records.length
    markSessionAuthorityRevalidated(resolvedDir, sessionID)
  } catch {
    // Preserve prior transcript on failure (Query request state carries error).
    return
  }
  if (isStale()) return

  seedSessionTodosFromHydratedTranscript({
    directory: resolvedDir,
    sessionID,
    store,
    isStale,
  })
  await reconcileActiveSessionStatusAfterMessagePull({
    directory: resolvedDir,
    sessionID,
    store,
    statusBeforePull,
    statusObservedAtBeforePull,
    hasMessages: recordCount > 0,
  })
}
