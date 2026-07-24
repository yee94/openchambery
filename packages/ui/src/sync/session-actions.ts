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
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { retry } from "./retry"
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import { loadSessionMessage, loadSessionMessagePage, recoverAssistantTailBoundary } from "./session-message-loader"
import { getInitialSessionMessagePageSize } from "./session-message-page-size"
import { beginSessionMessageLoad, failSessionMessageLoad, getSessionPrefetch, setSessionPrefetch } from "./session-prefetch-cache"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"

const MESSAGE_REFETCH_LIMIT = 100
const SEND_CONFIRMATION_REFETCH_LIMIT = 30
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
  if (!status || status.type === "idle") return messageId
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index].id
  }
  return undefined
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

export function dirStoreForDirectory(directory: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory)
}

function dirStoreForSession(sessionId: string, directoryOverride?: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = directoryOverride ?? getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

/**
 * Provider/model of the session's last assistant message — the authoritative
 * "session provider" for utility calls (notes distillation etc.), independent
 * of what the composer picker currently points at.
 */
export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const { store } = dirStoreForSession(sessionId)
    const messages = store.getState().message[sessionId]
    if (!messages) return null
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
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
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

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
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
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 *
 * Insert the optimistic user row before the connection grace wait so a
 * long-idle reconnect cannot leave the composer cleared / status busy while
 * the chat list still shows the pre-send snapshot.
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
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new SendDispatchError("pre-dispatch", new Error("Optimistic refs not set — is useSync() mounted?"))
  }

  const targetDirectory = input.directory ?? dir()
  const capture = captureSendTarget(targetDirectory)
  const transport = captureRuntimeTransport()
  let transportEntered = false
  let messageID: string | undefined
  try {
    assertCurrentSendTarget(capture, transport)
    input.beforeOptimisticInsert?.()
    assertCurrentSendTarget(capture, transport)

    messageID = input.messageID ?? ascendingId("msg")
    input.onMessageID?.(messageID)

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

    await waitForConnectionOrThrow()
    assertCurrentSendTarget(capture, transport)
    transportEntered = true
    await input.send(messageID)
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
    if (!messageID || !isCurrentSendTarget(capture, transport)) throw dispatchError
    const acceptedRecords = failureKind === "ambiguous-dispatched" && !input.preserveOptimisticOnAmbiguous
      ? await fetchRecentSendConfirmationRecords(input.sessionId, messageID, targetDirectory)
      : null

    if (acceptedRecords && isCurrentSendTarget(capture, transport)) {
      materializeConfirmedSendRecords(capture.store, input.sessionId, messageID, acceptedRecords)
      _optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID,
      })
      return
    }

    if (input.preserveOptimisticOnAmbiguous && failureKind === "ambiguous-dispatched") throw dispatchError
    // Rollback via optimistic infrastructure
    _optimisticRemove({
      sessionID: input.sessionId,
      directory: targetDirectory,
      messageID,
    })
    const s = capture.store.getState()
    const now = Date.now()
    capture.store.setState({
      session_status: {
        ...s.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
      session_status_observed_at: {
        ...s.session_status_observed_at,
        [input.sessionId]: now,
      },
    })
    throw dispatchError
  }
}

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
 * Pure optimistic insertion helper — inserts a user message into the child
 * store and shadow Map without waiting for connection or calling send.
 * Used by the combined createWithPrompt flow where the server has already
 * accepted the message before this materialization point.
 *
 * Respects the shadow Map protocol: registers with real sessionID + provided
 * messageID so mergeOptimisticPage can deduplicate. If SSE has already
 * delivered the message (found in child store), skips insertion.
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

  // If SSE already materialized this message, skip insertion
  const state = store.getState()
  const existingMessages = state.message?.[input.sessionId]
  if (existingMessages?.some((m) => m.id === input.messageID)) {
    return false
  }

  const optimisticParts: Part[] = input.parts
    ? input.parts.map((part) => ({
        ...part,
        id: typeof part.id === "string" && part.id ? part.id : ascendingId("prt"),
        messageID: input.messageID,
        sessionID: input.sessionId,
      } as Part))
    : [{ id: ascendingId("prt"), type: "text", text: input.content, messageID: input.messageID, sessionID: input.sessionId } as Part]
  if (!input.parts && input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: ascendingId("prt"), type: "file", mime: f.mime, url: f.url, filename: f.filename } as Part)
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

  _optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })

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

export async function fetchRecentSendConfirmationRecords(
  sessionId: string,
  messageID: string,
  directory?: string | null,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Array<{ info: Message; parts?: Part[] }> | null> {
  const controller = options?.signal || options?.timeoutMs !== undefined ? new AbortController() : null
  const abortFromSignal = () => controller?.abort()
  options?.signal?.addEventListener("abort", abortFromSignal, { once: true })
  if (options?.signal?.aborted) controller?.abort()
  const timeout = options?.timeoutMs === undefined ? undefined : setTimeout(() => controller?.abort(), Math.max(0, options.timeoutMs))
  try {
    for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
      if (controller?.signal.aborted) return null
      if (attempt > 0) await wait(SEND_CONFIRMATION_REFETCH_RETRY_MS)
      try {
        const result = await sdk().session.messages({
          sessionID: sessionId,
          directory: directory ?? undefined,
          limit: SEND_CONFIRMATION_REFETCH_LIMIT,
          ...(controller ? { signal: controller.signal } : {}),
        } as Parameters<ReturnType<typeof sdk>["session"]["messages"]>[0] & { signal?: AbortSignal })
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

export function materializeConfirmedSendRecords(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  records: Array<{ info: Message; parts?: Part[] }>,
): void {
  store.setState((state) => {
    const currentMessages = state.message[sessionId]
    const message = { ...state.message }
    const part = { ...state.part }
    if (currentMessages) {
      const nextMessages = currentMessages.filter((message) => message.id !== messageID)
      message[sessionId] = nextMessages
    }
    delete part[messageID]

    const materialized = materializeSessionSnapshots(
      { ...state, message, part },
      sessionId,
      records.map((record) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
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
  const { directory } = dirStoreForSession(sessionId)
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
  } catch (error) {
    if (scope && blockToken) useSessionUIStore.getState().clearQueueAbortBlock(scope, blockToken)
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
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call the runtime revert endpoint and merge returned session
 * 5. Set pendingInputText so the reverted message text appears in the input
 */
export type RevertedComposerSnapshot = {
  text: string
  attachments: Array<{ url: string; mimeType: string; filename: string }>
}

export async function revertToMessage(
  sessionId: string,
  messageId: string,
  options?: string | { directory?: string; restorePrimaryInput?: boolean },
): Promise<RevertedComposerSnapshot> {
  const directoryOverride = typeof options === "string" ? options : options?.directory
  const restorePrimaryInput = typeof options === "string" || options?.restorePrimaryInput !== false
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  const state = store.getState()

  // Abort if busy before mutating session state
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore abort errors
    }
  }

  // Extract message text for prompt restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  let messageText = ""
  let submittedFileParts: Array<Record<string, unknown>> = []
  if (targetMsg && targetMsg.role === "user") {
    const parts = state.part[messageId] ?? []
    const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
    messageText = textParts
      .map((p: Record<string, unknown>) => (p as { text?: string }).text || (p as { content?: string }).content || "")
      .join("\n")
      .trim()
    // Snapshot file parts for later restoration to the input.
    // Exclude synthetic file parts (server-generated file content that should
    // not be restored to the composer).
    submittedFileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>
  }
  const restoration: RevertedComposerSnapshot = {
    text: messageText,
    attachments: submittedFileParts.flatMap((part) => {
      const url = typeof part.url === "string" ? part.url : ""
      if (!url) return []
      return [{
        url,
        mimeType: typeof part.mime === "string" ? part.mime : "application/octet-stream",
        filename: typeof part.filename === "string" ? part.filename : "attachment",
      }]
    }),
  }

  // Optimistically set only the revert marker. Keep messages and parts in the
  // local store; visible-message selectors derive the displayed timeline from
  // session.revert. This matches the server model and preserves reverted
  // messages for the restore dock without maintaining a separate shadow copy.
  const prevRevert = (() => {
    const s = state.session.find((s) => s.id === sessionId)
    return (s as Session & { revert?: unknown })?.revert
  })()
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  const patch: Record<string, unknown> = {}

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
    patch.session = sessions
  }

  store.setState(patch)

  // Save input store state before mutations — if the API fails we need to
  // roll back both text and attachments to their previous values.
  const prevInputAttachments = [...useInputStore.getState().attachedFiles]
  const prevInputText = useInputStore.getState().pendingInputText
  const prevInputMode = useInputStore.getState().pendingInputMode

  // Restore reverted message text and file attachments to input
  if (restorePrimaryInput && messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }

  // Restore file/image attachments from the target message.
  // Clear existing attachments first — previous revert's attachments
  // must not carry over, even when the current message has no files.
  if (restorePrimaryInput) restoreFilePartsToInput(submittedFileParts)

  // Call SDK and merge authoritative result into store
  try {
    const revertedSession = await opencodeClient.revertSession(sessionId, messageId, undefined, directory)
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
    // Rollback: restore removed messages + revert marker
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
    }
    store.setState({
      session: rollback,
    })
    // Rollback input store: restore previous text and attachments
    if (restorePrimaryInput) {
      useInputStore.setState({
        pendingInputText: prevInputText,
        pendingInputMode: prevInputMode,
      })
      useInputStore.getState().setAttachedFiles(prevInputAttachments)
    }
    throw err
  }
}

function removeSessionMessageFromStore(store: DirectoryStoreApi, sessionId: string, messageId: string): void {
  const current = store.getState()
  const messages = current.message[sessionId]
  const hasParts = current.part[messageId] !== undefined
  if (!messages && !hasParts) return

  const message = { ...current.message }
  if (messages) {
    const next = [...messages]
    const result = Binary.search(next, messageId, (item) => item.id)
    if (result.found) {
      next.splice(result.index, 1)
      message[sessionId] = next
    }
  }

  const part = { ...current.part }
  delete part[messageId]
  store.setState({ message, part })
}

export function stageMessageEdit(sessionId: string, messageId: string, snapshot?: MessageEditSnapshot): void {
  let targetMessage = snapshot?.info
  let targetParts = snapshot?.parts

  if (snapshot) {
    const visibleMessage = snapshot.info
    if (
      visibleMessage.id !== messageId
      || visibleMessage.sessionID !== sessionId
      || visibleMessage.role !== "user"
    ) {
      throw new Error("The selected user message is unavailable")
    }
  } else {
    const { store } = dirStoreForSession(sessionId)
    const state = store.getState()
    const messages = state.message[sessionId] ?? []
    const targetIndex = messages.findIndex((message) => message.id === messageId)
    const storedMessage = targetIndex >= 0 ? messages[targetIndex] : undefined
    if (!storedMessage || storedMessage.role !== "user") {
      throw new Error("The selected user message is unavailable")
    }
    targetMessage = storedMessage
    targetParts = state.part[messageId] ?? []
  }

  if (!targetMessage || !targetParts) {
    throw new Error("The selected user message is unavailable")
  }

  const messageText = targetParts
    .filter((part) => part.type === "text" && !isSyntheticPart(part))
    .map((part: Record<string, unknown>) => (part as { text?: string }).text || (part as { content?: string }).content || "")
    .join("\n")
    .trim()
  const submittedFileParts = targetParts.filter((part) => part.type === "file" && !isSyntheticPart(part)) as Array<Record<string, unknown>>

  useInputStore.setState({
    pendingInputText: messageText,
    pendingInputMode: "replace" as const,
  })
  restoreFilePartsToInput(submittedFileParts)
}

/**
 * Commit a staged message edit immediately before sending its replacement.
 * The official delete-message endpoint removes conversation data only, so the
 * action deletes the target turn and every later message while retaining files.
 */
export async function commitMessageEdit(sessionId: string, messageId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const status = store.getState().session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore abort errors
    }
  }

  await refetchSessionMessages(sessionId)
  const messages = store.getState().message[sessionId] ?? []
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  const targetMessage = targetIndex >= 0 ? messages[targetIndex] : undefined
  if (!targetMessage || targetMessage.role !== "user") {
    throw new Error("The selected user message is unavailable")
  }

  for (const message of messages.slice(targetIndex).reverse()) {
    await opencodeClient.deleteSessionMessage(sessionId, message.id, directory)
    removeSessionMessageFromStore(store, sessionId, message.id)
  }
}

export async function refetchSessionMessages(sessionId: string, directoryOverride?: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  const result = await sdk().session.messages({ sessionID: sessionId, directory, limit: MESSAGE_REFETCH_LIMIT })
  const records = (assertSdkSuccess(result, "session.messages") ?? [])
    .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  if (records.length === 0) return

  store.setState((state) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionId,
      records.map((record: { info: Message; parts?: Part[] }) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()
  const previousMessageCount = state.message[sessionId]?.length ?? 0

  // Abort if busy
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore
    }
  }

  const result = await sdk().session.unrevert({ sessionID: sessionId, directory })
  const unrevertedSession = assertSdkData(result, "session.unrevert")
  const current = store.getState()
  const sessions = [...current.session]
  const idx = sessions.findIndex((s) => s.id === sessionId)
  if (idx >= 0) {
    sessions[idx] = unrevertedSession
    store.setState({ session: sessions })
  }
  for (let attempt = 0; attempt < UNREVERT_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(UNREVERT_REFETCH_RETRY_MS)
    await refetchSessionMessages(sessionId)
    const nextMessageCount = store.getState().message[sessionId]?.length ?? 0
    if (nextMessageCount > previousMessageCount) return
  }
}

/**
 * Fork from a message or the latest stable conversation turn.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call the runtime fork endpoint
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkSession(sessionId: string, operationId: number, messageId?: string, directoryOverride?: string): Promise<boolean> {
  const forkRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId, directoryOverride)
  if (!directory) throw new Error("Fork session directory is unavailable")
  const sourceSession = await ensureForkSourceSession(sessionId, store, directory)
  registerSessionDirectory(sessionId, directory)
  let state = store.getState()

  let sourceStatus = state.session_status[sessionId]
  let sourceMessages = state.message[sessionId] ?? []
  console.info("[session-fork] resolving fork point", {
    operationId,
    sessionId,
    requestedMessageId: messageId ?? null,
    statusType: sourceStatus?.type ?? "unknown",
    messageCount: sourceMessages.length,
  })
  let forkMessageId = resolveForkMessageId(messageId, sourceMessages, sourceStatus)
  if (!messageId && state.session_status[sessionId]?.type !== "idle" && !forkMessageId) {
    console.info("[session-fork] refreshing messages to resolve the active fork point", {
      operationId,
      sessionId,
    })
    await refetchSessionMessages(sessionId)
    state = store.getState()
    sourceStatus = state.session_status[sessionId]
    sourceMessages = state.message[sessionId] ?? []
    forkMessageId = resolveForkMessageId(undefined, sourceMessages, sourceStatus)
  }
  if (!messageId && state.session_status[sessionId]?.type !== "idle" && !forkMessageId) {
    console.error("[session-fork] active session has no user message fork point", {
      operationId,
      sessionId,
      statusType: state.session_status[sessionId]?.type ?? "unknown",
      messageCount: state.message[sessionId]?.length ?? 0,
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
  const forkSourceMessage = messageId
    ? (state.message[sessionId] ?? []).find((message) => message.id === messageId)
    : undefined
  const shouldRestoreComposer = forkSourceMessage?.role === "user"
  const parts = shouldRestoreComposer && messageId ? state.part[messageId] ?? [] : []
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
    // Insert new session into child store so sidebar updates immediately
    const current = store.getState()
    const sessions = [...current.session]
    const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
    if (!searchResult.found) {
      sessions.splice(searchResult.index, 0, forkedSession)
      store.setState({ session: sessions })
    }

    // Fork emits every cloned message and part over SSE. Discard any target data
    // that raced into the store so selection follows the regular bounded tail load.
    const beforeSelection = store.getState()
    const leakedMessages = beforeSelection.message[forkedSession.id] ?? []
    const nextMessages = { ...beforeSelection.message }
    const nextParts = { ...beforeSelection.part }
    delete nextMessages[forkedSession.id]
    for (const message of leakedMessages) {
      delete nextParts[message.id]
    }
    store.setState({ message: nextMessages, part: nextParts })

    // Switch immediately once OpenCode reveals the real ID, then keep the
    // transition visible until the bounded initial page is available.
    useSessionUIStore.getState().setCurrentSession(forkedSession.id, directory)
    await setForkTransitionStage(operationId, "loading")
    console.info("[session-fork] loading the forked session", {
      operationId,
      sessionId,
      forkedSessionId: forkedSession.id,
    })
    await fetchMessagesForSession(forkedSession.id, directory)
    const loadedMessages = store.getState().message[forkedSession.id] ?? []
    const newestLoadedMessageID = loadedMessages.at(-1)?.id
    if (newestLoadedMessageID) {
      forkCopyEventCutoffs.set(`${getRuntimeKey()}:${directory}:${forkedSession.id}`, {
        messageID: newestLoadedMessageID,
        expiresAt: Date.now() + FORK_COPY_EVENT_CUTOFF_TTL_MS,
      })
    }
  } finally {
    if (activeForkCopy?.operationId === operationId) activeForkCopy = null
  }

  // Restore forked message text and file attachments to input (user messages only)
  if (shouldRestoreComposer && messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }
  // A selected message owns its attachment restoration snapshot. A current-session
  // fork preserves the composer's existing resources.
  if (shouldRestoreComposer && messageId) restoreFilePartsToInput(fileParts)
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

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return

  const runtimeKey = getRuntimeKey()
  const limit = getInitialSessionMessagePageSize()
  const loadingKey = `${runtimeKey}:${resolvedDir}:${sessionID}:${limit}`
  if (!_sdk || !_childStores) {
    PENDING_MESSAGE_FETCHES.set(loadingKey, { sessionID, directory: resolvedDir })
    return
  }
  const existingRequest = FETCH_MESSAGES_LOADING.get(loadingKey)
  if (existingRequest) {
    return existingRequest
  }

  const request = fetchMessagesForSessionInternal(sessionID, resolvedDir, runtimeKey, limit)
  const trackedRequest = request.finally(() => {
    FETCH_MESSAGES_LOADING.delete(loadingKey)
  })
  FETCH_MESSAGES_LOADING.set(loadingKey, trackedRequest)
  return trackedRequest
}

async function fetchMessagesForSessionInternal(sessionID: string, resolvedDir: string, runtimeKey: string, limit: number): Promise<void> {
  try {
    const s = sdk()
    const store = dirStoreForDirectory(resolvedDir)

    const cachedState = store.getState()
    const cachedMessages = cachedState.message[sessionID]
    const cachedComplete = getSessionPrefetch(resolvedDir, sessionID)?.complete === true
    const isUserRole = (message: Message) =>
      message.role === "user" || (message as Message & { clientRole?: string }).clientRole === "user"
    const hasUserBoundary = cachedMessages?.some(isUserRole)
    // Narrow cache bypass for the long-idle send race: status can be busy while
    // the list is still the pre-send snapshot (no trailing user row). Do NOT
    // force-refetch every busy session — that would add needless network on
    // ordinary switches and is unnecessary once optimistic insert already
    // painted the user bubble. Only bypass when live work and the local tail
    // does not already look like a send in progress.
    const liveStatus = cachedState.session_status?.[sessionID]?.type
    const sessionIsLive = liveStatus === "busy" || liveStatus === "retry"
    const lastMessage = cachedMessages?.[cachedMessages.length - 1]
    const tailLooksLikeInFlightSend = Boolean(lastMessage && isUserRole(lastMessage))
    const mustRefetchLiveStaleCache = sessionIsLive && !tailLooksLikeInFlightSend
    if (
      !mustRefetchLiveStaleCache
      && getSessionMaterializationStatus(cachedState, sessionID).renderable
      && (hasUserBoundary || cachedComplete)
    ) {
      return
    }

    beginSessionMessageLoad(resolvedDir, sessionID, limit, runtimeKey)

    const result = await loadSessionMessagePage({
      runtimeKey,
      directory: resolvedDir,
      sessionID,
      limit,
      request: () => retry(async () => {
        const response = await s.session.messages({
          sessionID,
          directory: resolvedDir,
          limit,
        })
        assertSdkSuccess(response, "session.messages")
        return response
      }),
    })

    const records = (assertSdkSuccess(result, "session.messages") ?? [])
      .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
    const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
    const recovered = await recoverAssistantTailBoundary({
      records: records.map((record: { info: Message; parts?: Part[] }) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      complete: !cursor,
      requestMessage: async (messageID) => {
        const response = await loadSessionMessage({
          runtimeKey,
          directory: resolvedDir,
          sessionID,
          messageID,
          request: async () => {
            const result = await s.session.message({ sessionID, messageID, directory: resolvedDir })
            assertSdkSuccess(result, "session.message")
            return result
          },
        })
        const record = assertSdkSuccess(response, "session.message")
        if (!record?.info?.id) throw new Error("session.message failed: empty response")
        return { info: stripMessageDiffSnapshots(record.info), parts: record.parts ?? [] }
      },
    })
    const completeRecords = recovered.records

    // Staleness guard: a rapid session switch may have moved the user off this
    // session while the fetch was in flight. Skip the write so a slow fetch
    // can't repopulate (and un-evict) a session already navigated away from.
    if (useSessionUIStore.getState().currentSessionId !== sessionID) {
      setSessionPrefetch({ directory: resolvedDir, sessionID, runtimeKey, limit: completeRecords.length, cursor, complete: !cursor })
      return
    }

    const latestState = store.getState()
    const latestStatus = getSessionMaterializationStatus(latestState, sessionID)
    if (latestStatus.renderable && (latestState.message[sessionID]?.length ?? 0) >= completeRecords.length) {
      setSessionPrefetch({ directory: resolvedDir, sessionID, runtimeKey, limit: completeRecords.length, cursor, complete: !cursor })
      return
    }

    store.setState((state) => {
      const materialized = materializeSessionSnapshots(
        state,
        sessionID,
        completeRecords,
        { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
      )
      if (!materialized.messagesChanged && !materialized.partsChanged) return state
      return { message: materialized.message, part: materialized.part }
    })
    setSessionPrefetch({
      directory: resolvedDir,
      sessionID,
      runtimeKey,
      limit: completeRecords.length,
      cursor,
      complete: !cursor,
    })
  } catch (error) {
    // Transient failure — the reactive path in ChatContainer will retry
    failSessionMessageLoad(resolvedDir, sessionID, formatSdkError(error), runtimeKey)
  }
}
