/**
 * Session UI Store — ephemeral UI state only.
 *
 * Domain data (sessions, messages, parts, permissions, questions, status)
 * lives in sync child stores. This store owns ONLY transient UI concerns:
 * current selection, draft state, viewport anchors, model/agent preferences,
 * voice state, abort prompts, attached files, worktree metadata.
 *
 * Session↔worktree attachments are the authoritative exception: they live in
 * session-worktree-store (shared sync), and session-ui-store routes through it.
 *
 * SDK-calling actions that need domain data read it from sync-refs.
 */

import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile, SessionContextUsage, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client"
import { runtimeFetch, setRuntimeInteractiveSessionRequestId } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { commandQueryOptions, readCommandsSnapshot } from "@/queries/commandQueries"
import { queryClient } from "@/lib/queryRuntime"
import { installedSkillsQueryOptions, readInstalledSkillsSnapshot } from "@/queries/installedSkillsQueries"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { normalizePath } from "@/lib/pathNormalization"
import { waitForPendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap"
import { getWorktreeSetupWaitEnabled } from "@/lib/openchamberConfig"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { createUuid } from "@/lib/uuid"
import { ascendingId } from "./message-id"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { ConversationCreateWithPromptResult, ConversationCreateWithPromptInput } from "@/lib/api/types"
import type { I18nKey } from "@/lib/i18n/messages/en"
import {
  getSyncSessions,
  getAllSyncSessions,
  getSyncMessages,
  getSyncParts,
  getDirectoryState,
} from "./sync-refs"
import { registerSessionDirectory } from "./sync-refs"
import { markSessionViewed } from "./notification-store"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  archiveSession as archiveSessionAction,
  updateSessionTitle as updateSessionTitleAction,
  shareSession as shareSessionAction,
  unshareSession as unshareSessionAction,
  optimisticSend,
  optimisticInsertUserMessage,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  stageMessageEdit,
  commitMessageEdit,
  unrevertSession as unrevertSessionAction,
  forkSession as forkSessionAction,
  fetchMessagesForSession,
  fetchRecentSendConfirmationRecords,
  materializeConfirmedSendRecords,
  dirStoreForDirectory,
} from "./session-actions"
import { useInputStore, type InputDraftRuntimeCapture, type DraftOwnershipCommitResult, type SyntheticContextPart } from "./input-store"
import { newSessionDraftKey, sessionDraftKey, type DraftKey } from "./input-draft-types"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { setSessionGoal } from "@/lib/sessionGoalActions"
import { wrapSystemReminder } from "@/lib/systemReminder"
import { useUIStore } from "@/stores/useUIStore"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { getAttachedSessionDirectory } from "./session-worktree-contract"
import { queueScopeKey, type QueueScope } from "@/stores/messageQueueStore"
import { setSessionOpener } from "./session-opener"
import { getRuntimeKey, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import { rememberRuntimeLiveStatus } from "./runtime-live-memory"
import { beginSessionSwitchMeasure } from "@/lib/sessionSwitchPerf"
import { sessionLoadDebug } from "./session-load-debug"
import { announceSessionSwitchIntent } from "@/lib/sessionSwitchIntent"

export type { AttachedFile }

export type MessageEditSnapshot = {
  info: Message
  parts: Part[]
}

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

export async function routeMessage(params: {
  sessionId: string
  directory?: string | null
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  variant?: string
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  delivery?: 'steer'
  messageID?: string
  preserveOptimisticOnAmbiguous?: boolean
  onSendConfirmed?: (messageID: string) => void
}): Promise<void> {
  const requestDirectory = params.directory ?? undefined
  const onSendConfirmed = createConfirmedSendCallback(params.sessionId, params.onSendConfirmed)
  let content = params.content
  if (params.inputMode === "shell") {
    const messageID = params.messageID ?? ascendingId("msg")
    return opencodeClient.shellSession({
      sessionId: params.sessionId,
      directory: requestDirectory,
      agent: params.agent ?? "",
      model: { providerID: params.providerID, modelID: params.modelID },
      command: params.content,
    }).then(() => {
      onSendConfirmed(messageID)
    })
  }

  // Slash commands — fire and forget, SSE delivers messages and status
  if (params.content.startsWith("/")) {
    const separatorIndex = params.content.search(/\s/u)
    const head = separatorIndex === -1 ? params.content : params.content.slice(0, separatorIndex)
    const argumentsText = separatorIndex === -1 ? "" : params.content.slice(separatorIndex).trim()
    const cmdName = head.slice(1)

    // OpenCode also exposes skills through its command catalog. Resolve the
    // installed skill catalog first so slash-invoked skills stay on the prompt
    // path and reach the model through the skill tool.
    const queryDirectory = requestDirectory ?? useDirectoryStore.getState().currentDirectory ?? null
    const transport = getRuntimeTransportIdentity()
    const commandsQuery = commandQueryOptions(queryDirectory, transport)
    const skillsQuery = installedSkillsQueryOptions(queryDirectory, transport)
    const commandsQueryState = queryClient.getQueryState(commandsQuery.queryKey)
    const skillsQueryState = queryClient.getQueryState(skillsQuery.queryKey)
    const hasCommandsSnapshot = commandsQueryState?.data !== undefined
    const hasSkillsSnapshot = skillsQueryState?.data !== undefined
    const [commands, installedSkills] = await Promise.all([
      hasCommandsSnapshot
        ? Promise.resolve(readCommandsSnapshot(queryDirectory, transport))
        : queryClient.fetchQuery({ ...commandsQuery, staleTime: Infinity }),
      hasSkillsSnapshot
        ? Promise.resolve(readInstalledSkillsSnapshot(queryClient, queryDirectory, transport))
        : queryClient.fetchQuery({ ...skillsQuery, staleTime: Infinity }),
    ])

    if (getRuntimeTransportIdentity() !== transport) {
      throw new Error("Runtime changed while resolving slash command")
    }

    const isSkill = installedSkills.some((skill) => skill.name === cmdName)
    const command = isSkill ? undefined : commands.find((candidate) => candidate.name === cmdName)

    if (command?.isBuiltIn === false) {
      content = `[command:${command.reference ?? command.name}]${argumentsText ? ` ${argumentsText}` : ""}`
    } else if (command) {
      return optimisticSend({
        sessionId: params.sessionId,
        content: params.content,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        directory: requestDirectory,
        files: params.files,
        messageID: params.messageID,
        preserveOptimisticOnAmbiguous: params.preserveOptimisticOnAmbiguous,
        onSendConfirmed,
        send: (messageID) => opencodeClient.sendCommand({
          id: params.sessionId,
          providerID: params.providerID,
          modelID: params.modelID,
          command: cmdName,
          arguments: argumentsText,
          agent: params.agent,
          variant: params.variant,
          files: params.files,
          messageId: messageID,
          directory: requestDirectory,
        }).then(() => {}),
      })
    }
  }

  // Normal prompt — optimistic insert so message appears instantly
  return optimisticSend({
    sessionId: params.sessionId,
    content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: params.agent,
    directory: requestDirectory,
    files: params.files,
    messageID: params.messageID,
    preserveOptimisticOnAmbiguous: params.preserveOptimisticOnAmbiguous,
    onSendConfirmed,
    send: (messageID) => opencodeClient.sendMessage({
      id: params.sessionId,
      providerID: params.providerID,
      modelID: params.modelID,
      text: content,
      agent: params.agent,
      agentMentions: params.agentMentionName ? [{ name: params.agentMentionName }] : undefined,
      variant: params.variant,
      files: params.files,
      additionalParts: params.additionalParts,
      delivery: params.delivery,
      messageId: messageID,
      directory: requestDirectory,
    }).then(() => {}),
  })
}

type SendMessageOptions = {
  sessionId?: string
  directoryHint?: string | null
  delivery?: 'steer'
  commitStagedMessageEdit?: boolean
  messageID?: string
  preserveOptimisticOnAmbiguous?: boolean
  onSendConfirmed?: (messageID: string) => void
}

export function notifyConfirmedMessageSent(sessionId: string, messageID: string): void {
  runtimeFetch(`/api/sessions/${sessionId}/message-sent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID }),
  })
    .catch(() => { /* ignore */ })
}

function createConfirmedSendCallback(
  sessionId: string,
  onSendConfirmed?: (messageID: string) => void,
): (messageID: string) => void {
  let confirmed = false
  return (messageID) => {
    if (confirmed) return
    confirmed = true
    try {
      onSendConfirmed?.(messageID)
    } finally {
      notifyConfirmedMessageSent(sessionId, messageID)
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SyntheticContextPart } from "./input-store"
export type { SessionMemoryState } from "./viewport-store"

export type NewSessionDraftState = {
  /** Whether the new-session draft composer is currently open (no real session yet). */
  open: boolean
  /**
   * Stable identity for this open draft. Created on first open; retained across
   * idle re-opens; rotated when opening while a submission is in flight; cleared on close.
   */
  draftID: string | null
  /** Project the draft is bound to (Welcome / sidebar / deep-link target). */
  selectedProjectId?: string | null
  /** Explicit working directory for the session that will be created from this draft. */
  directoryOverride: string | null
  /** When true, auto-accept permissions once the draft materializes into a session. */
  permissionAutoAcceptEnabled?: boolean
  /**
   * In-flight worktree creation request id. resolveDraftDirectory waits on it
   * before create/prompt so the new session lands in the pending worktree.
   */
  pendingWorktreeRequestId?: string | null
  /**
   * Directory that should become the draft target after async bootstrap
   * (e.g. worktree prep) finishes; preferred over directoryOverride while set.
   */
  bootstrapPendingDirectory?: string | null
  /**
   * When true, keep directoryOverride even if project selection would otherwise
   * rewrite the draft directory (deep-link / explicit path targets).
   */
  preserveDirectoryOverride?: boolean
  /** Parent session id when this draft is a child/fork create, else null. */
  parentID: string | null
  /** Optional title applied at session create time. */
  title?: string
  /** Optional seed prompt retained with the draft (not the live composer text). */
  initialPrompt?: string
  /**
   * Synthetic context parts (conflict resolution, handoff, etc.) merged into
   * the first send when the draft is claimed.
   */
  syntheticParts?: SyntheticContextPart[]
  /** Sidebar folder to place the created session into after materialization. */
  targetFolderId?: string
  /**
   * Monotonic claim token for this draftID. Incremented by claimDraftSubmission;
   * CAS restore/finalization require draftID + token (+ runtime) to match.
   */
  submissionToken?: number
  /**
   * True after claimDraftSubmission owns the send: full-screen establishing UI
   * until a real session id is selected. Blocks concurrent draft sends.
   */
  draftSubmitting?: boolean
  /**
   * UI-only prelude before claimDraftSubmission: ChatInput paints the
   * establishing page while it still awaits response-style / snippet prep.
   * Cleared when the real claim takes over or the send aborts.
   */
  draftEstablishing?: boolean
}

export type ForkTransitionStage = "preparing" | "copying" | "opening" | "loading"

export type ForkTransitionState = {
  operationId: number
  sourceSessionId: string
  directory: string
  stage: ForkTransitionStage
}

type OpenNewSessionDraftOptions = Omit<Partial<NewSessionDraftState>, "draftID" | "open" | "submissionToken" | "draftSubmitting" | "draftEstablishing"> & {
  /**
   * An explicit directory from an external deep link represents a project
   * target. If it is not already covered by a project or worktree, register
   * it before creating the draft so the first session appears in the sidebar.
   */
  ensureProjectForDirectory?: boolean
}

export type ViewportAnchor = {
  sessionId: string
  value: number
}

export type SessionHistoryMeta = {
  limit: number
  hasMore: boolean
  complete: boolean
  isLoading: boolean
  loading?: boolean
  nextCursor?: string
}

export type SessionUIState = {
  currentSessionId: string | null
  currentSessionDirectory: string | null
  newSessionDraft: NewSessionDraftState
  forkTransition: ForkTransitionState | null
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktrees: WorktreeMetadata[]
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>
  queueAbortBlocks: Map<string, { token: string; expiresAt: number }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null
  // Plan mode - per-session plan file availability (set when plan_enter tool creates a plan)
  sessionPlanAvailable: Map<string, boolean>
  markSessionPlanAvailable: (sessionId: string) => void
  isSessionPlanAvailable: (sessionId: string) => boolean

  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives
  pendingChangesBarDismissed: Map<string, string>
  stagedMessageEdit: { sessionId: string; messageId: string } | null
  dismissPendingChangesBar: (sessionId: string, signature: string | null) => void

  // Actions — UI state management
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  openNewSessionDraft: (options?: OpenNewSessionDraftOptions) => void
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  beginQueueAbortBlock: (scope: Extract<QueueScope, { state: "bound" }>, durationMs?: number) => string
  clearQueueAbortBlock: (scope: Extract<QueueScope, { state: "bound" }>, token: string) => void
  pruneQueueAbortBlocks: (now?: number) => void
  clearAbortPrompt: () => void
  armAbortPrompt: (durationMs?: number) => number | null
  clearError: () => void
  markSessionAsOpenChamberCreated: (sessionId: string) => void
  isOpenChamberCreatedSession: (sessionId: string) => boolean
  getContextUsage: (contextLimit: number, outputLimit: number) => SessionContextUsage | null
  initializeNewOpenChamberSession: (sessionId: string, agents: unknown[]) => void
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: Record<string, unknown>) => void
  setDraftBootstrapPendingDirectory: (directory: string | null) => void
  setPendingDraftWorktreeRequest: (requestId: string | null) => void
  getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | undefined

  // Actions — SDK-calling operations (read domain data from sync-refs)
  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null, metadata?: Record<string, unknown>) => Promise<Session | null>
  deleteSession: (id: string, options?: Record<string, unknown>) => Promise<boolean>
  deleteSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  shareSession: (sessionId: string) => Promise<Session | null>
  unshareSession: (sessionId: string) => Promise<Session | null>
  revertToMessage: (sessionId: string, messageId: string, options?: { skipRedoPush?: boolean }) => Promise<void>
  editMessagePreservingChanges: (sessionId: string, messageId: string, snapshot?: MessageEditSnapshot) => void
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  forkCurrentSession: (sessionId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string, options?: { fullUnrevert?: boolean }) => Promise<void>

  // Data access helpers (read from sync)
  getSessionsByDirectory: (directory: string) => Session[]
  getAuthoritativeDirectoryForSession: (sessionId: string) => string | null
  getDirectoryForSession: (sessionId: string) => string | null
  getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null
  getCurrentAgent: (sessionId: string) => string | undefined
  debugSessionMessages: (sessionId: string) => Promise<void>
  pollForTokenUpdates: () => void
  setSessionDirectory: (sessionId: string, directory: string | null) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  return normalizePath(sessionRecord.directory ?? null)
    ?? normalizePath(sessionRecord.project?.worktree ?? null)
}

const safeStorage = getDeferredSafeStorage()
const DRAFT_TARGET_STORAGE_KEY = "oc.chatInput.lastDraftTarget"

type PersistedDraftTarget = { projectId: string | null; directory: string | null }

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
    }
  } catch {
    return null
  }
}

const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target))
  } catch { /* ignored */ }
}

const resolveDraftProjectForDirectory = resolveProjectForSessionDirectory

const getAttachmentForSession = (sessionId: string | null | undefined): SessionWorktreeAttachment | undefined => {
  if (!sessionId) return undefined
  return useSessionWorktreeStore.getState().getAttachment(sessionId)
}

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
  options?: { includeRuntimeMemory?: boolean },
): string | null => {
  if (!sessionId) return null
  const attachmentDirectory = getAttachedSessionDirectory(getAttachmentForSession(sessionId))
  if (attachmentDirectory) return attachmentDirectory
  const metaPath = getWtMeta(sessionId)?.path
  if (typeof metaPath === "string" && metaPath.trim().length > 0) return normalizePath(metaPath)
  if (options?.includeRuntimeMemory !== false) {
    const runtimeMemory = runtimeSessionMemory.get(runtimeMemoryKey())
    if (runtimeMemory?.sessionId === sessionId && runtimeMemory.directory) {
      return normalizePath(runtimeMemory.directory)
    }
  }
  const sessions = getAllSyncSessions()
  const target = sessions.find((s) => s.id === sessionId)
  if (!target) return null
  return resolveDirectoryKey(target)
}

/** Best-effort session snapshot for fork toasts — live child store, then global index. */
const resolveForkSourceSessionSnapshot = (sessionId: string): Session | null => {
  const fromSync = getAllSyncSessions().find((session) => session.id === sessionId)
  if (fromSync) return fromSync
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

const activateConfigForDirectory = async (directory: string | null | undefined): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory))
}

const DEFAULT_DRAFT: NewSessionDraftState = {
  open: false,
  draftID: null,
  directoryOverride: null,
  parentID: null,
  draftSubmitting: false,
  draftEstablishing: false,
}

const activeSessionByRuntime = new Map<string, string | null>()
let nextForkOperationId = 0
type RuntimeSessionMemory = {
  sessionId: string | null
  directory: string | null
  draft: NewSessionDraftState
}
const runtimeSessionMemory = new Map<string, RuntimeSessionMemory>()

const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim()
  return key || "default"
}

const cloneDraft = (draft: NewSessionDraftState): NewSessionDraftState => ({ ...draft })

const writeRuntimeSessionMemory = (key: string, patch: Partial<RuntimeSessionMemory>): void => {
  const current = runtimeSessionMemory.get(key)
  runtimeSessionMemory.set(key, {
    sessionId: current?.sessionId ?? null,
    directory: current?.directory ?? null,
    draft: current?.draft ? cloneDraft(current.draft) : { ...DEFAULT_DRAFT },
    ...patch,
  })
}

type MaterializedDraftSession = {
  sessionId: string
  directory: string | null
  agent?: string
  syntheticParts?: SyntheticContextPart[]
}

type DraftSubmissionClaim = {
  token: number
  draftID: string
  draft: NewSessionDraftState
  runtime: InputDraftRuntimeCapture
  runtimeMemoryKey: string
  source: { key: DraftKey; revision: number } | null
}

const resolveProjectRefForWorktreeDirectory = (directory: string | null, projectId?: string | null): { id: string; path: string } | null => {
  const projectsState = useProjectsStore.getState()
  if (projectId) {
    const project = projectsState.projects.find((entry) => entry.id === projectId)
    if (project?.path) return { id: project.id, path: project.path }
  }
  const resolved = resolveProjectForSessionDirectory(projectsState.projects, useSessionUIStore.getState().availableWorktreesByProject, directory)
  return resolved?.path ? { id: resolved.id, path: resolved.path } : null
}

const waitForWorktreeBootstrapIfConfigured = async (directory: string | null, projectId?: string | null): Promise<void> => {
  if (!directory) return
  const project = resolveProjectRefForWorktreeDirectory(directory, projectId)
  if (project && await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory)
  }
}

const promoteProjectForConversation = (
  directory: string | null,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
): void => {
  const projectsState = useProjectsStore.getState()
  const project = resolveProjectForSessionDirectory(
    projectsState.projects,
    availableWorktreesByProject,
    directory,
  )
  if (project) {
    projectsState.moveProjectToTop(project.id)
  }
}

const sameRuntimeCapture = (a: InputDraftRuntimeCapture, b: InputDraftRuntimeCapture): boolean =>
  a.transportIdentity === b.transportIdentity && a.generation === b.generation

const hasClaimDraftIdentity = (draft: NewSessionDraftState, claim: DraftSubmissionClaim): boolean =>
  draft.open
    && draft.draftSubmitting === true
    && draft.draftID === claim.draftID
    && draft.submissionToken === claim.token

const isCurrentClaimDraft = (draft: NewSessionDraftState, claim: DraftSubmissionClaim): boolean =>
  hasClaimDraftIdentity(draft, claim)
    && sameRuntimeCapture(useInputStore.getState().captureDraftRuntime(), claim.runtime)

/**
 * Paint the full-screen "establishing conversation" page before ChatInput's
 * network preamble (response-style fetch / snippet expand). Does not claim
 * submission — claimDraftSubmission still owns idempotency.
 */
export async function beginDraftEstablishingPaint(): Promise<boolean> {
  let started = false
  useSessionUIStore.setState((s) => {
    const d = s.newSessionDraft
    if (!d?.open || !d.draftID || d.draftSubmitting || d.draftEstablishing) return {}
    started = true
    const nextDraft: NewSessionDraftState = { ...d, draftEstablishing: true }
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
    return { newSessionDraft: nextDraft }
  })
  if (!started) return false
  // Same paint gate as claimDraftSubmission / forkTransition.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const currentDraft = useSessionUIStore.getState().newSessionDraft
  return currentDraft.open === true && currentDraft.draftEstablishing === true
}

export function clearDraftEstablishingPaint(): void {
  useSessionUIStore.setState((s) => {
    const d = s.newSessionDraft
    if (!d?.draftEstablishing) return {}
    const nextDraft: NewSessionDraftState = { ...d, draftEstablishing: false }
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
    return { newSessionDraft: nextDraft }
  })
}

async function claimDraftSubmission(): Promise<DraftSubmissionClaim | null> {
  let draftID: string | null = null
  let token: number | null = null
  let memoryKey: string | null = null
  useSessionUIStore.setState((s) => {
    const d = s.newSessionDraft
    // draftEstablishing is UI prelude only — still allow the real claim.
    if (!d?.open || d.draftSubmitting || !d.draftID) return {}
    const nextToken = (d.submissionToken ?? 0) + 1
    const nextDraft: NewSessionDraftState = {
      ...d,
      draftSubmitting: true,
      draftEstablishing: false,
      submissionToken: nextToken,
    }
    memoryKey = runtimeMemoryKey()
    draftID = nextDraft.draftID
    token = nextToken
    writeRuntimeSessionMemory(memoryKey, { draft: nextDraft })
    return { newSessionDraft: nextDraft }
  })
  if (!draftID || token === null || !memoryKey) return null
  // Same paint gate as forkTransition: let React commit the full-screen
  // establishing page before create/prompt work continues.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const currentDraft = useSessionUIStore.getState().newSessionDraft
  // Runtime switch / reopen / close during the paint frame invalidates this claim.
  if (
    !currentDraft.open
    || currentDraft.draftSubmitting !== true
    || currentDraft.draftID !== draftID
    || currentDraft.submissionToken !== token
  ) {
    return null
  }
  const runtime = useInputStore.getState().captureDraftRuntime()
  const sourceKey = newSessionDraftKey(runtime, draftID)
  const source = useInputStore.getState().getDraft(sourceKey)
  return {
    token,
    draftID,
    draft: cloneDraft(currentDraft),
    runtime,
    runtimeMemoryKey: memoryKey,
    source: source ? { key: sourceKey, revision: source.revision } : null,
  }
}

function restoreDraftSubmission(claim: DraftSubmissionClaim): void {
  useSessionUIStore.setState((s) => {
    const d = s.newSessionDraft
    if (isCurrentClaimDraft(d, claim)) {
      const restored: NewSessionDraftState = { ...d, draftSubmitting: false, draftEstablishing: false }
      const memory = runtimeSessionMemory.get(claim.runtimeMemoryKey)
      if (memory && hasClaimDraftIdentity(memory.draft, claim)) {
        writeRuntimeSessionMemory(claim.runtimeMemoryKey, { draft: restored })
      }
      return { newSessionDraft: restored }
    }
    return {}
  })
  const memory = runtimeSessionMemory.get(claim.runtimeMemoryKey)
  if (memory && hasClaimDraftIdentity(memory.draft, claim)) {
    writeRuntimeSessionMemory(claim.runtimeMemoryKey, { draft: { ...memory.draft, draftSubmitting: false, draftEstablishing: false } })
  }
}

function clearStaleClaimMemory(claim: DraftSubmissionClaim): void {
  const memory = runtimeSessionMemory.get(claim.runtimeMemoryKey)
  if (memory && hasClaimDraftIdentity(memory.draft, claim)) {
    writeRuntimeSessionMemory(claim.runtimeMemoryKey, { draft: { ...DEFAULT_DRAFT } })
  }
}

async function finalizeClaimedDraftOwnership(
  claim: DraftSubmissionClaim,
  sessionID: string,
  disposition: "preserve" | "consume",
): Promise<DraftOwnershipCommitResult | null> {
  if (!claim.source) return null
  let result: DraftOwnershipCommitResult
  try {
    result = await useInputStore.getState().finalizeDraftOwnership({
      source: claim.source.key,
      destination: sessionDraftKey(claim.runtime, sessionID),
      expectedSourceRevision: claim.source.revision,
      disposition,
      runtime: claim.runtime,
    })
  } catch {
    console.warn("[session-ui-store] draft ownership finalization rejected", {
      disposition,
      sessionID,
      draftID: claim.draftID,
    })
    return null
  }
  if (result.status !== "committed") {
    console.warn("[session-ui-store] draft ownership finalization did not commit", {
      status: result.status,
      disposition,
      sessionID,
      draftID: claim.draftID,
    })
  }
  return result
}

interface FinalizeDraftSessionParams {
  directory: string | null
  agent?: string
  draftProjectId?: string | null
  targetFolderId?: string
  draftSyntheticParts?: SyntheticContextPart[]
}

function recordCreatedSession(created: Session, directory: string | null): void {
  const sessionDir = directory ?? (created as { directory?: string }).directory ?? null
  if (sessionDir) {
    registerSessionDirectory(created.id, sessionDir)
  }
  useGlobalSessionsStore.getState().upsertSession(created)
  useSessionUIStore.getState().markSessionAsOpenChamberCreated(created.id)
}

async function finalizeDraftSession(
  created: Session,
  selection: { providerID: string; modelID: string; agent?: string; variant?: string },
  params: FinalizeDraftSessionParams,
  claim?: DraftSubmissionClaim,
): Promise<MaterializedDraftSession & { selected: boolean }> {
  const store = useSessionUIStore.getState()
  const { targetFolderId, draftProjectId, draftSyntheticParts } = params
  const createdDirectory = normalizePath(params.directory ?? created.directory ?? null)
  const currentDraft = store.newSessionDraft
  const draftPermissionAutoAcceptEnabled = currentDraft.permissionAutoAcceptEnabled === true
  const stale = claim !== undefined && !isCurrentClaimDraft(currentDraft, claim)
  recordCreatedSession(created, createdDirectory)
  const configState = useConfigStore.getState()
  const effectiveDraftAgent = params.agent ?? configState.currentAgentName
  if (targetFolderId) {
    const scopeKey = params.directory || useSessionUIStore.getState().lastLoadedDirectory || (created as { directory?: string }).directory
    if (scopeKey) {
      useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, created.id)
    }
  }
  if (!stale) {
    persistDraftTarget({ projectId: draftProjectId ?? null, directory: createdDirectory })
    void activateConfigForDirectory(createdDirectory).catch((error) => { console.warn("Failed to activate directory after creating session:", error) })
    useSelectionStore.getState().saveSessionModelSelection(created.id, selection.providerID, selection.modelID)
    if (effectiveDraftAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
      useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID)
      useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID, selection.variant)
    }
    store.initializeNewOpenChamberSession(created.id, configState.agents ?? [])
    store.setCurrentSession(created.id, createdDirectory)
    promoteProjectForConversation(createdDirectory, useSessionUIStore.getState().availableWorktreesByProject)
    if (draftPermissionAutoAcceptEnabled) {
      void import("@/stores/permissionStore")
        .then(({ usePermissionStore }) => usePermissionStore.getState().setSessionAutoAccept(created.id, true))
        .catch((error) => {
          console.warn("Failed to apply draft permission auto-accept to new session:", error)
        })
    }
  }
  if (stale && claim) clearStaleClaimMemory(claim)
  return {
    sessionId: created.id,
    directory: createdDirectory,
    agent: effectiveDraftAgent,
    syntheticParts: draftSyntheticParts,
    selected: !stale,
  }
}

async function resolveDraftDirectory(draft: NewSessionDraftState): Promise<{ directory: string | null; projectId: string | null }> {
  let directoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
  const projectId = draft.selectedProjectId ?? null
  if (draft.pendingWorktreeRequestId) {
    directoryOverride = await waitForPendingDraftWorktreeRequest(draft.pendingWorktreeRequestId)
    useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(draft.pendingWorktreeRequestId, directoryOverride)
  }
  await waitForWorktreeBootstrapIfConfigured(directoryOverride, projectId)
  const resolvedDir = directoryOverride ?? opencodeClient.getDirectory()
  return { directory: normalizePath(resolvedDir), projectId }
}

async function materializeClaimedDraftSession(selection: {
  providerID: string; modelID: string; agent?: string; variant?: string
}): Promise<{ materialized: MaterializedDraftSession; claim: DraftSubmissionClaim } | null> {
  const claimed = await claimDraftSubmission()
  if (!claimed) return null
  const { draft } = claimed
  const trimmedAgent = typeof selection.agent === "string" && selection.agent.trim().length > 0 ? selection.agent.trim() : undefined
  try {
    const { directory } = await resolveDraftDirectory(draft)
    const dir = directory ?? opencodeClient.getDirectory()
    const created = await createSessionAction(draft.title, dir, draft.parentID ?? null, undefined)
    if (!created?.id) throw new Error("Failed to create session")
    const finalized = await finalizeDraftSession(created, selection, {
      directory: directory ?? (created as { directory?: string }).directory ?? null,
      agent: trimmedAgent,
      draftProjectId: draft.selectedProjectId,
      targetFolderId: draft.targetFolderId,
      draftSyntheticParts: draft.syntheticParts,
    }, claimed)
    return { materialized: finalized, claim: claimed }
  } catch {
    restoreDraftSubmission(claimed)
    return null
  }
}

export async function materializeOpenDraftSession(selection: {
  providerID: string; modelID: string; agent?: string; variant?: string
}): Promise<MaterializedDraftSession | null> {
  const result = await materializeClaimedDraftSession(selection)
  if (!result) return null
  await finalizeClaimedDraftOwnership(result.claim, result.materialized.sessionId, "preserve")
  return result.materialized
}

const COMBINED_RETRY_MAX = 2
const COMBINED_RETRY_DELAY_MS = 300

async function localizedSendError(key: I18nKey): Promise<Error> {
  const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
  const { dictionary } = useI18nStore.getState()
  return new Error(formatMessage(dictionary, key))
}

async function handleCombinedDraftSend(params: {
  content: string; providerID: string; modelID: string; agent?: string; agentMentionName?: string; variant?: string
  attachments?: AttachedFile[]; additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>
}): Promise<void> {
  const { content, providerID, modelID, agent, agentMentionName, variant, attachments, additionalParts } = params
  const claimed = await claimDraftSubmission()
  if (!claimed) throw await localizedSendError("chat.chatInput.toast.messageSendFailed")
  const { draft } = claimed
  try {
    const { directory } = await resolveDraftDirectory(draft)
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
    const configState = useConfigStore.getState()
    const effectiveAgent = trimmedAgent ?? configState.currentAgentName
    const files: Array<{ type: "file"; mime: string; url: string; filename: string }> = attachments?.map((a: AttachedFile) => ({ type: "file" as const, mime: a.mimeType, url: a.dataUrl, filename: a.filename })) ?? []
    const mergedAdditionalParts = draft.syntheticParts?.length ? [...(additionalParts || []), ...draft.syntheticParts] : additionalParts
    const mappedAdditionalParts = mergedAdditionalParts?.map((p) => ({ text: p.text, synthetic: p.synthetic, files: p.attachments?.map((a: AttachedFile) => ({ type: "file" as const, mime: a.mimeType, url: a.dataUrl, filename: a.filename })) }))
    const agentMentions = agentMentionName ? [{ name: agentMentionName }] : undefined
    const parts = await opencodeClient.buildMessageParts({ text: content, files: files.length > 0 ? files : undefined, additionalParts: mappedAdditionalParts, agentMentions })
    const messageID = ascendingId("msg")
    const api = getRegisteredRuntimeAPIs()?.conversations
    if (!api?.createWithPrompt) { throw await localizedSendError("chat.chatInput.toast.messageSendFailed") }
    const resolvedDir = directory ?? opencodeClient.getDirectory() ?? ""
    let result: ConversationCreateWithPromptResult | undefined
    for (let attempt = 0; attempt <= COMBINED_RETRY_MAX; attempt++) {
      if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, COMBINED_RETRY_DELAY_MS))
      try {
        result = await api.createWithPrompt({ input: { type: 'prompt' }, directory: resolvedDir, ...(draft.title ? { title: draft.title } : {}), ...(draft.parentID ? { parentID: draft.parentID } : {}), messageID, model: { providerID, modelID }, ...(effectiveAgent ? { agent: effectiveAgent } : {}), ...(variant ? { variant } : {}), parts: parts as ConversationCreateWithPromptInput['parts'] })
        // Only `unavailable` (server busy) is retryable amongst structured failures
        if (!result || result.ok || (result as { phase?: string }).phase !== 'unavailable') break
        result = undefined
        if (attempt === COMBINED_RETRY_MAX) break
      } catch {
        if (attempt === COMBINED_RETRY_MAX) break
      }
    }
    if (!result) { restoreDraftSubmission(claimed); useInputStore.getState().setPendingInputText(content, "replace"); throw await localizedSendError("chat.chatInput.toast.messageSendFailed") }
    if (result.ok) {
      const session = result.session as Session; const sessionDir = directory ?? (session as { directory?: string }).directory ?? null
      const finalized = await finalizeDraftSession(session, { providerID, modelID, agent: effectiveAgent, variant }, { directory: sessionDir, agent: effectiveAgent, draftProjectId: draft.selectedProjectId, targetFolderId: draft.targetFolderId, draftSyntheticParts: draft.syntheticParts }, claimed)
      await finalizeClaimedDraftOwnership(claimed, session.id, "consume")
      notifyConfirmedMessageSent(session.id, messageID)
      if (finalized.selected) markPendingUserSendAnimation(session.id)
      if (finalized.selected && sessionDir) {
        const dirState = getDirectoryState(sessionDir); const existingMessages = dirState?.message?.[session.id]
        if (!existingMessages?.some((m: Message) => m.id === messageID)) {
          const inserted = optimisticInsertUserMessage({ sessionId: session.id, messageID, content, providerID, modelID, agent: effectiveAgent, directory: sessionDir, files })
          if (!inserted && !existingMessages?.length) console.warn("[combined] optimistic insert skipped (refs not mounted), session:", session.id)
        }
      }
      return
    }
    if (!result.ok) {
      const phase = (result as { ok: false; phase: string }).phase
      if (phase === 'create' || phase === 'validate' || phase === 'conflict' || phase === 'unavailable' || phase === 'internal') {
        restoreDraftSubmission(claimed); useInputStore.getState().setPendingInputText(content, "replace")
        throw await localizedSendError("chat.chatInput.toast.messageSendFailed")
      }
      if (phase === 'prompt') {
        const promptResult = result as Extract<ConversationCreateWithPromptResult, { ok: false; phase: 'prompt' }>
        const session = promptResult.session as Session; const sessionDir = directory ?? (session as { directory?: string }).directory ?? null
        const finalized = await finalizeDraftSession(session, { providerID, modelID, agent: effectiveAgent, variant }, { directory: sessionDir, agent: effectiveAgent, draftProjectId: draft.selectedProjectId, targetFolderId: draft.targetFolderId, draftSyntheticParts: draft.syntheticParts }, claimed)
        if (promptResult.ambiguous) {
          const records = await fetchRecentSendConfirmationRecords(session.id, messageID, sessionDir)
          if (records) {
            await finalizeClaimedDraftOwnership(claimed, session.id, "consume")
            notifyConfirmedMessageSent(session.id, messageID)
            if (finalized.selected) markPendingUserSendAnimation(session.id)
            const store = dirStoreForDirectory(sessionDir ?? opencodeClient.getDirectory() ?? "")
            materializeConfirmedSendRecords(store, session.id, messageID, records)
            return
          }
          await finalizeClaimedDraftOwnership(claimed, session.id, "preserve")
          useInputStore.getState().setPendingInputText(content, "replace"); throw await localizedSendError("chat.chatInput.toast.sendStatusUnknown")
        }
        await finalizeClaimedDraftOwnership(claimed, session.id, "preserve")
        useInputStore.getState().setPendingInputText(content, "replace"); throw await localizedSendError("chat.chatInput.toast.messageSendFailed")
      }
    }
  } catch (_error) { restoreDraftSubmission(claimed); throw _error }
}


// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persisted worktree map (stale-while-revalidate)
//
// Worktree discovery is async (git), so the worktree→project map isn't ready at
// startup. Persist it so (a) the sidebar worktree list paints instantly, and
// (b) useConfigStore.resolveConfigDirectory can map a worktree to its project on
// the FIRST launch — yielding a single project-scoped config load instead of a
// worktree+project double-load. Discovery refreshes it in the background.
// ---------------------------------------------------------------------------
const WORKTREE_MAP_STORAGE_KEY = 'oc.worktreeMap'

const loadPersistedWorktreeMap = (): Map<string, WorktreeMetadata[]> => {
  try {
    const raw = getDeferredSafeStorage().getItem(WORKTREE_MAP_STORAGE_KEY)
    if (!raw) return new Map()
    const entries = JSON.parse(raw) as Array<[string, WorktreeMetadata[]]>
    if (!Array.isArray(entries)) return new Map()
    return new Map(
      entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])),
    )
  } catch {
    return new Map()
  }
}

const persistWorktreeMap = (serialized: string): void => {
  try {
    getDeferredSafeStorage().setItem(WORKTREE_MAP_STORAGE_KEY, serialized)
  } catch {
    // quota / serialization error — ignore; discovery still refreshes at runtime
  }
}

const flattenWorktreeMap = (map: Map<string, WorktreeMetadata[]>): WorktreeMetadata[] => {
  const out: WorktreeMetadata[] = []
  for (const list of map.values()) out.push(...list)
  return out
}

const PERSISTED_WORKTREE_MAP = loadPersistedWorktreeMap()

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  currentSessionDirectory: null,
  newSessionDraft: { ...DEFAULT_DRAFT },
  forkTransition: null,
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  availableWorktrees: flattenWorktreeMap(PERSISTED_WORKTREE_MAP),
  availableWorktreesByProject: PERSISTED_WORKTREE_MAP,
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  queueAbortBlocks: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,
  sessionPlanAvailable: new Map(),
  pendingChangesBarDismissed: new Map(),
  stagedMessageEdit: null,

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null) => {
    announceSessionSwitchIntent(id)
    setRuntimeInteractiveSessionRequestId(id)
    const previousSessionId = get().currentSessionId
    const previousDirectory = get().currentSessionDirectory
    if (previousSessionId !== id) {
      beginSessionSwitchMeasure()
    }
    if (id) {
      get().closeNewSessionDraft()
    }
    useInputStore.getState().setActiveAttachmentDraft(
      id ? sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, id) : null,
    )

    const key = runtimeMemoryKey()
    activeSessionByRuntime.set(key, id)

    const directoryState = useDirectoryStore.getState()

    const sessionDir = resolveSessionDirectory(
      id,
      (sid) => get().worktreeMetadata.get(sid),
    )
    const fallbackDir = opencodeClient.getDirectory() ?? directoryState.currentDirectory ?? null
    const resolvedDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir ?? fallbackDir
    sessionLoadDebug("selection", {
      sessionID: id,
      previousSessionID: previousSessionId,
      directory: resolvedDir,
      directoryHint,
      currentDirectory: directoryState.currentDirectory,
    })
    const projectsState = useProjectsStore.getState()
    const sessionProject = resolvedDir
      ? resolveProjectForSessionDirectory(
        projectsState.projects,
        get().availableWorktreesByProject,
        resolvedDir,
      )
      : null

    // Set the directory together with the session id so chat hooks read the
    // same child store that send/SSE events will update during startup races.
    set({ currentSessionId: id, currentSessionDirectory: id ? resolvedDir ?? null : null })
    writeRuntimeSessionMemory(key, { sessionId: id, directory: resolvedDir ?? null })

    // Workspace panels (context/subagent/file preview + right sidebar git/files)
    // are session-correlated: hide when leaving, restore when returning.
    if (previousSessionId !== id) {
      useUIStore.getState().syncWorkspacePanelsForSessionSwitch({
        previousSessionId,
        previousDirectory,
        nextSessionId: id,
        nextDirectory: id ? resolvedDir ?? null : null,
      })
    }

    // Kick off the message fetch on the same tick, before React commits the
    // state change and fires ChatContainer.useEffect. The fetch is
    // fire-and-forget — any transient failure gets retried by the reactive path.
    if (id) {
      sessionLoadDebug("imperative-dispatch", { sessionID: id, directory: resolvedDir })
      void fetchMessagesForSession(id, resolvedDir)
    }

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      }
      if (sessionProject && projectsState.activeProjectId !== sessionProject.id) {
        projectsState.setActiveProjectIdOnly(sessionProject.id)
      }
      opencodeClient.setDirectory(resolvedDir ?? undefined)
    } catch (e) {
      console.warn("Failed to set OpenCode directory for session switch:", e)
    }

    // Defer viewport anchor save for previous session — not needed for the
    // skeleton to render and reads messages which can be expensive.
    if (previousSessionId && previousSessionId !== id) {
      const prevId = previousSessionId
      setTimeout(() => {
        const memState = getViewportSessionMemory(prevId)
        if (!memState?.isStreaming) {
          const prevMessages = getSyncMessages(prevId)
          if (prevMessages.length > 0) {
            useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
          }
        }
      }, 0)
    }

    // Mark session viewed in notification store + update active session ref
    if (id) {
      markSessionViewed(id)
      setActiveSession(resolvedDir ?? "", id)
    }
  },

  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const directory = useDirectoryStore.getState().currentDirectory || null
    const currentSessionId = get().currentSessionId
    const directorySnapshot = directory ? getDirectoryState(directory) : null
    rememberRuntimeLiveStatus({
      runtimeKey: key,
      directory,
      sessionId: currentSessionId,
      status: currentSessionId ? directorySnapshot?.session_status?.[currentSessionId] : null,
    })
    activeSessionByRuntime.set(key, get().currentSessionId)
    writeRuntimeSessionMemory(key, {
      sessionId: currentSessionId,
      directory,
      draft: cloneDraft(get().newSessionDraft),
    })
    set({ queueAbortBlocks: new Map() })
  },

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const restoredSessionId = memory?.sessionId ?? activeSessionByRuntime.get(key) ?? null
    setRuntimeInteractiveSessionRequestId(restoredSessionId)
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const restoredDirectory = memory?.directory ?? null
    if (restoredDirectory) {
      useDirectoryStore.getState().setDirectory(restoredDirectory, { showOverlay: false })
    }
    set({
      currentSessionId: restoredSessionId,
      currentSessionDirectory: restoredSessionId ? restoredDirectory : null,
      newSessionDraft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
      forkTransition: null,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      error: null,
      sessionAbortFlags: new Map(),
      queueAbortBlocks: new Map(),
      pendingChangesBarDismissed: new Map(),
      stagedMessageEdit: null,
    })
    useInputStore.getState().setActiveAttachmentDraft(
      restoredSessionId
        ? sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, restoredSessionId)
        : restoredDraft.open && restoredDraft.draftID
          ? newSessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, restoredDraft.draftID)
          : null,
    )
    if (restoredSessionId) {
      setActiveSession(restoredDirectory ?? opencodeClient.getDirectory() ?? "", restoredSessionId)
    } else {
      setActiveSession("", "")
    }
  },

  // ---------------------------------------------------------------------------
  // openNewSessionDraft
  // ---------------------------------------------------------------------------
  openNewSessionDraft: (options) => {
    const existingDraft = get().newSessionDraft
    let projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = get().availableWorktreesByProject
    // Prefer the active conversation workspace over the directory store / last draft
    // target so Mod+N (and other unscoped "new session" entry points) land on Welcome
    // already switched to the project the user was just talking in.
    const conversationDirectory = normalizePath(get().currentSessionDirectory ?? null)
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    const explicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const inferredProjectFromDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, explicitDirectory)
    const ensuredProject = options?.ensureProjectForDirectory && explicitDirectory && !inferredProjectFromDir
      ? projectsState.addProject(explicitDirectory)
      : null

    // addProject synchronously activates and persists the project. Re-read
    // before resolving draft defaults so this draft binds to the new entry.
    if (ensuredProject) {
      projectsState = useProjectsStore.getState()
    }
    const resolvedProjects = projectsState.projects
    const activeProject = projectsState.getActiveProject()
    const explicitProject = options?.selectedProjectId
      ? resolvedProjects.find((p) => p.id === options.selectedProjectId) ?? null
      : null

    const fallbackProject = (() => {
      if (activeProject) return activeProject
      if (projectsState.activeProjectId) return resolvedProjects.find((p) => p.id === projectsState.activeProjectId) ?? null
      return resolvedProjects[0] ?? null
    })()

    const persistedProjectById = persistedTarget?.projectId
      ? resolvedProjects.find((p) => p.id === persistedTarget.projectId) ?? null
      : null
    const persistedProjectByDir = resolveDraftProjectForDirectory(resolvedProjects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const conversationProject = resolveDraftProjectForDirectory(resolvedProjects, availableWorktreesByProject, conversationDirectory)
    const currentDirProject = resolveDraftProjectForDirectory(resolvedProjects, availableWorktreesByProject, currentDirectory)

    const selectedProject = (() => {
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return ensuredProject ?? inferredProjectFromDir
      // Live conversation wins over directory-store / last-draft heuristics.
      if (conversationProject) return conversationProject
      // Preserve orphan-directory behavior: a known cwd that matches no project
      // must not silently inherit the active project.
      if (currentDirectory) return currentDirProject
      return persistedProjectByDir ?? persistedProjectById ?? fallbackProject
    })()

    const directory = (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      // Keep the conversation directory (incl. worktree) when starting from a live session.
      if (conversationDirectory) return conversationDirectory
      if (currentDirectory) return currentDirectory
      if (persistedTarget?.directory) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    persistDraftTarget({ projectId: selectedProject?.id ?? null, directory })

    // Mirror sidebar "new session" behavior: switch the active project to the Welcome target.
    if (selectedProject && projectsState.activeProjectId !== selectedProject.id) {
      projectsState.setActiveProjectIdOnly(selectedProject.id)
    }

    const nextDraft: NewSessionDraftState = {
      open: true,
      draftID: existingDraft.open && !existingDraft.draftSubmitting && !existingDraft.draftEstablishing
        ? existingDraft.draftID ?? createUuid()
        : createUuid(),
      selectedProjectId: selectedProject?.id ?? null,
      directoryOverride: directory,
      permissionAutoAcceptEnabled: options?.permissionAutoAcceptEnabled === true,
      pendingWorktreeRequestId: options?.pendingWorktreeRequestId ?? null,
      bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true,
      parentID: options?.parentID ?? null,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
      syntheticParts: options?.syntheticParts,
      targetFolderId: options?.targetFolderId,
      submissionToken: existingDraft.open && !existingDraft.draftSubmitting && !existingDraft.draftEstablishing
        ? existingDraft.submissionToken
        : 0,
      draftSubmitting: false,
      draftEstablishing: false,
    }

    // Capture before clearing so right-side workspace panels can hide/restore
    // the same way session-to-session switches do via setCurrentSession().
    const previousSessionId = get().currentSessionId
    const previousDirectory = get().currentSessionDirectory

    set({
      newSessionDraft: {
        ...nextDraft,
      },
      currentSessionId: null,
      currentSessionDirectory: null,
      error: null,
    })
    setRuntimeInteractiveSessionRequestId(null)

    // Workspace panels (context/subagent/file preview + right sidebar git/files)
    // are session-correlated. openNewSessionDraft bypasses setCurrentSession, so
    // it must call the same switch boundary or open panels bleed onto the draft.
    if (previousSessionId) {
      useUIStore.getState().syncWorkspacePanelsForSessionSwitch({
        previousSessionId,
        previousDirectory,
        nextSessionId: null,
        nextDirectory: null,
      })
    }

    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: nextDraft })
    useInputStore.getState().setActiveAttachmentDraft(
      newSessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, nextDraft.draftID!),
    )
    // Clear composer attachments when opening a new session draft.
    // Attachments from the previous session (e.g. restored by revert) must
    // not bleed into the new session's input.
    useInputStore.getState().clearAttachedFiles()

    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    // Config (providers/agents/default model+agent) lives at the PROJECT level. When the user
    // came from a worktree session, `directory` is the worktree path, whose provider list does
    // not include project/global-scoped providers (e.g. the default agent's non-opencode model)
    // — resolving defaults against it would wrongly fall back to opencode/big-pickle. Activate
    // the project's config instead so the default cascade matches app startup, then re-apply it
    // (a fresh draft must start from defaults, not inherit the previous session's selection).
    const configDirectory = normalizePath(selectedProject?.path ?? null) ?? directory
    void activateConfigForDirectory(configDirectory).then(() => {
      useConfigStore.getState().applyDefaultModelAgentSelection({
        projectDefaultModel: selectedProject?.defaultModel,
      })
    })

    if (directory && directory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(directory)
    }
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    const nextDraft: NewSessionDraftState = {
        open: false,
        draftID: null,
        selectedProjectId: null,
        directoryOverride: null,
        pendingWorktreeRequestId: null,
        bootstrapPendingDirectory: null,
        preserveDirectoryOverride: false,
        parentID: null,
        title: undefined,
        initialPrompt: undefined,
        syntheticParts: undefined,
        targetFolderId: undefined,
        draftSubmitting: false,
        draftEstablishing: false,
      }
    set({
      newSessionDraft: nextDraft,
    })
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  },

  setNewSessionDraftTarget: (target, options) => {
    let nextDirectory: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      // force: explicit user/target updates must release create-time draft locks so
      // selecting project root (e.g. main) after a new worktree is not a no-op.
      // selectedDraftDirectory prefers bootstrapPendingDirectory over directoryOverride.
      const force = options?.force === true
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId,
          directoryOverride: target.directoryOverride ?? s.newSessionDraft.directoryOverride,
          ...(force
            ? {
                bootstrapPendingDirectory: null,
                preserveDirectoryOverride: false,
              }
            : {}),
        },
      }
    })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  setDraftPermissionAutoAcceptEnabled: (enabled) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, permissionAutoAcceptEnabled: enabled } }
    }),

  acknowledgeSessionAbort: (sessionId) =>
    set((s) => {
      const flags = new Map(s.sessionAbortFlags)
      const existing = flags.get(sessionId)
      if (existing) flags.set(sessionId, { ...existing, acknowledged: true })
      return { sessionAbortFlags: flags }
    }),

  beginQueueAbortBlock: (scope, durationMs = 2000) => {
    const token = createUuid()
    const key = queueScopeKey(scope)
    set((state) => {
      const queueAbortBlocks = new Map(state.queueAbortBlocks)
      queueAbortBlocks.set(key, { token, expiresAt: Date.now() + durationMs })
      return { queueAbortBlocks }
    })
    return token
  },

  clearQueueAbortBlock: (scope, token) =>
    set((state) => {
      const key = queueScopeKey(scope)
      if (state.queueAbortBlocks.get(key)?.token !== token) return state
      const queueAbortBlocks = new Map(state.queueAbortBlocks)
      queueAbortBlocks.delete(key)
      return { queueAbortBlocks }
    }),

  pruneQueueAbortBlocks: (now = Date.now()) =>
    set((state) => {
      let queueAbortBlocks: Map<string, { token: string; expiresAt: number }> | undefined
      for (const [key, block] of state.queueAbortBlocks) {
        if (block.expiresAt > now) continue
        if (!queueAbortBlocks) queueAbortBlocks = new Map(state.queueAbortBlocks)
        queueAbortBlocks.delete(key)
      }
      return queueAbortBlocks ? { queueAbortBlocks } : state
    }),

  clearAbortPrompt: () => set({ abortPromptSessionId: null, abortPromptExpiresAt: null }),

  armAbortPrompt: (durationMs = 5000) => {
    const { currentSessionId } = get()
    if (!currentSessionId) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: currentSessionId, abortPromptExpiresAt: expiresAt })
    return expiresAt
  },

  clearError: () => set({ error: null }),

  markSessionAsOpenChamberCreated: (sessionId) =>
    set((s) => {
      const next = new Set(s.webUICreatedSessions)
      next.add(sessionId)
      return { webUICreatedSessions: next }
    }),

  isOpenChamberCreatedSession: (sessionId) => get().webUICreatedSessions.has(sessionId),

  getContextUsage: (contextLimit: number, outputLimit: number) => {
    if (get().newSessionDraft?.open) return null
    const sessionId = get().currentSessionId
    if (!sessionId) return null

    const messages = getSyncMessages(sessionId)
    if (messages.length === 0) return null

    type AssistantTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    let lastTokens: AssistantTokens | undefined
    let lastMessageId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const tokens = (msg as { tokens?: AssistantTokens }).tokens
      if (!tokens) continue
      const total = tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      if (total > 0) {
        lastTokens = tokens
        lastMessageId = msg.id
        break
      }
    }

    if (!lastTokens) return null

    const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0)
    const thresholdLimit = contextLimit > 0 ? contextLimit : 200000
    const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0
    const normalizedOutput = outputLimit > 0 ? Math.round((lastTokens.output / outputLimit) * 100) : undefined

    return {
      totalTokens,
      percentage,
      contextLimit: contextLimit || 0,
      outputLimit: outputLimit || undefined,
      normalizedOutput,
      thresholdLimit,
      lastMessageId,
    }
  },

  initializeNewOpenChamberSession: () => {
    // Stub — was a no-op in old store
  },

  setWorktreeMetadata: (sessionId, metadata) => {
    // Write to authoritative session-worktree-store
    if (metadata) {
      useSessionWorktreeStore.getState().setAttachment(sessionId, {
        worktreeRoot: metadata.worktreeRoot ?? metadata.path ?? null,
        cwd: metadata.path ?? null,
        branch: metadata.branch ?? null,
        headState: metadata.headState ?? (metadata.branch ? 'branch' : 'detached'),
        worktreeStatus: metadata.worktreeStatus ?? 'ready',
        worktreeSource: metadata.worktreeSource ?? null,
        legacy: false,
        degraded: false,
      })
    } else {
      useSessionWorktreeStore.getState().clearAttachment(sessionId)
    }
    // Also keep local map for backward compatibility
    set((s) => {
      const map = new Map(s.worktreeMetadata)
      if (metadata) map.set(sessionId, metadata)
      else map.delete(sessionId)
      return { worktreeMetadata: map }
    })
  },

  overrideNewSessionDraftTarget: (options) => {
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      return { newSessionDraft: nextDraft }
    })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  resolvePendingDraftWorktreeTarget: (requestId, directory, options) =>
    set((s) => {
      if (!s.newSessionDraft?.open || s.newSessionDraft.pendingWorktreeRequestId !== requestId) return s
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: (options as Record<string, unknown> | undefined)?.projectId as string ?? s.newSessionDraft.selectedProjectId ?? null,
          directoryOverride: normalizePath(directory),
          pendingWorktreeRequestId: null,
          bootstrapPendingDirectory: normalizePath((options as Record<string, unknown> | undefined)?.bootstrapPendingDirectory as string ?? s.newSessionDraft.bootstrapPendingDirectory ?? null),
          preserveDirectoryOverride: ((options as Record<string, unknown> | undefined)?.preserveDirectoryOverride ?? true) as boolean,
        },
      }
    }),

  setDraftBootstrapPendingDirectory: (directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, bootstrapPendingDirectory: normalizePath(directory) } }
    }),

  setPendingDraftWorktreeRequest: (requestId) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, pendingWorktreeRequestId: requestId } }
    }),

  getWorktreeMetadata: (sessionId) => get().worktreeMetadata.get(sessionId),

  dismissPendingChangesBar: (sessionId, signature) => {
    const map = new Map(get().pendingChangesBarDismissed);
    if (signature === null) {
      map.delete(sessionId);
    } else {
      map.set(sessionId, signature);
    }
    set({ pendingChangesBarDismissed: map });
  },

  // ---------------------------------------------------------------------------
  // sendMessage — calls SDK, reads domain data from sync
  // ---------------------------------------------------------------------------
  // Armed goal (composer target button): the sent prompt becomes the goal
  // objective; budget comes from the global default setting. Fire-and-forget —
  // a failed metadata patch must not fail the send.
  sendMessage: async (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    const stagedMessageEdit = get().stagedMessageEdit
    const requestedSessionId = options?.sessionId ?? get().currentSessionId
    if (options?.commitStagedMessageEdit && stagedMessageEdit && stagedMessageEdit.sessionId === requestedSessionId) {
      await commitMessageEdit(stagedMessageEdit.sessionId, stagedMessageEdit.messageId)
      if (get().stagedMessageEdit === stagedMessageEdit) {
        set({ stagedMessageEdit: null })
      }
    }

    // Clear non-Git changed-files bar on new user message for current session
    const sid = options?.sessionId ?? get().currentSessionId;
    if (sid) {
      const map = new Map(get().pendingChangesBarDismissed);
      map.delete(sid);
      set({ pendingChangesBarDismissed: map });
    }

    const draft = get().newSessionDraft
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined

    const goalArm = inputMode !== "shell" && content.trim().length > 0
      ? useSessionGoalArmStore.getState().consume()
      : { armed: false, objectiveOverride: null }
    const goalArmed = goalArm.armed
    if (goalArmed) {
      // Teach the agent the goal protocol from turn one — without this it
      // only learns about goal mode from the first server continuation.
      const uiState = useUIStore.getState()
      const budgetLine = uiState.sessionGoalDefaultBudgetEnabled
        ? ` A token budget of ${uiState.sessionGoalDefaultBudget} tokens applies to this goal.`
        : ""
      const goalIntro = wrapSystemReminder(
        "Goal mode is active for this session. The user message above defines the goal objective. "
        + "Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. "
        + "Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains."
        + budgetLine,
      )
      additionalParts = [...(additionalParts ?? []), { text: goalIntro, synthetic: true }]
    }
    const applyArmedGoal = (goalSessionId: string, goalDirectory: string | null | undefined) => {
      if (!goalArmed) return
      const uiState = useUIStore.getState()
      const tokenBudget = uiState.sessionGoalDefaultBudgetEnabled ? uiState.sessionGoalDefaultBudget : null
      const objective = goalArm.objectiveOverride?.trim() || content
      void setSessionGoal(goalSessionId, goalDirectory ?? undefined, { objective, tokenBudget }, null)
        .catch((error) => {
          console.warn("[session-ui-store] failed to set goal from armed send", error)
        })
    }

    // ---- New session from draft ----
    if (!options?.sessionId && draft?.open) {
      const canUseCombined =
        inputMode !== "shell" &&
        !content.trimStart().startsWith("/") &&
        !options?.delivery &&
        getRegisteredRuntimeAPIs()?.conversations?.createWithPrompt;

      if (canUseCombined) {
        await handleCombinedDraftSend({
          content,
          providerID,
          modelID,
          agent: trimmedAgent,
          agentMentionName,
          variant,
          attachments,
          additionalParts,
        })
        return
      }

      const materialized = await materializeClaimedDraftSession({
        providerID,
        modelID,
        agent: trimmedAgent,
        variant,
      })
      if (!materialized) throw new Error("Failed to create session")
      const { materialized: createdDraftSession, claim } = materialized

      const mergedAdditionalParts = createdDraftSession.syntheticParts?.length
        ? [...(additionalParts || []), ...createdDraftSession.syntheticParts]
        : additionalParts

      markPendingUserSendAnimation(createdDraftSession.sessionId)

      const files = attachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

      try {
        await routeMessage({
        sessionId: createdDraftSession.sessionId,
        directory: createdDraftSession.directory,
        content,
        providerID,
        modelID,
        agent: createdDraftSession.agent,
        agentMentionName,
        variant,
        inputMode,
        files,
        delivery: options?.delivery,
        messageID: options?.messageID,
        preserveOptimisticOnAmbiguous: options?.preserveOptimisticOnAmbiguous,
        onSendConfirmed: options?.onSendConfirmed,
        additionalParts: mergedAdditionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          files: p.attachments?.map((a: AttachedFile) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
          })),
        })),
        })
        await finalizeClaimedDraftOwnership(claim, createdDraftSession.sessionId, "consume")
      } catch (error) {
        await finalizeClaimedDraftOwnership(claim, createdDraftSession.sessionId, "preserve")
        throw error
      }
      promoteProjectForConversation(createdDraftSession.directory, get().availableWorktreesByProject)
      applyArmedGoal(createdDraftSession.sessionId, createdDraftSession.directory)
      return
    }

    // ---- Existing session ----
    const targetSessionId = options?.sessionId ?? get().currentSessionId
    const sessionAgentSelection = targetSessionId
      ? useSelectionStore.getState().getSessionAgentSelection(targetSessionId)
      : null
    const configAgentName = useConfigStore.getState().currentAgentName
    const effectiveAgent = trimmedAgent || sessionAgentSelection || configAgentName || undefined

    if (targetSessionId) {
      useSelectionStore.getState().saveSessionModelSelection(targetSessionId, providerID, modelID)
    }

    if (targetSessionId && effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(targetSessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelForSession(targetSessionId, effectiveAgent, providerID, modelID)
      useSelectionStore.getState().saveAgentModelVariantForSession(targetSessionId, effectiveAgent, providerID, modelID, variant)
    }

    if (targetSessionId) {
      const viewportState = useViewportStore.getState()
      const memState = getViewportSessionMemory(targetSessionId)
      if (!memState || !memState.lastUserMessageAt) {
        const newMemState = new Map(viewportState.sessionMemoryState)
        newMemState.set(viewportSessionKey(targetSessionId), {
          viewportAnchor: 0,
          isStreaming: false,
          lastAccessedAt: Date.now(),
          backgroundMessageCount: 0,
          ...memState,
          lastUserMessageAt: Date.now(),
        })
        useViewportStore.setState({ sessionMemoryState: newMemState })
      }
    }

    const currentSessionDirectory = targetSessionId
      ? normalizePath(options?.directoryHint) ?? normalizePath(get().getDirectoryForSession(targetSessionId))
      : null
    if (targetSessionId) {
      markPendingUserSendAnimation(targetSessionId)
    }

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
    }))

    await routeMessage({
      sessionId: targetSessionId || "",
      directory: currentSessionDirectory,
      content,
      providerID,
      modelID,
      agent: effectiveAgent,
      agentMentionName,
      variant,
      inputMode,
      files,
      delivery: options?.delivery,
      messageID: options?.messageID,
      preserveOptimisticOnAmbiguous: options?.preserveOptimisticOnAmbiguous,
      onSendConfirmed: options?.onSendConfirmed,
      additionalParts: additionalParts?.map((p) => ({
        text: p.text,
        synthetic: p.synthetic,
        files: p.attachments?.map((a) => ({
          type: "file" as const,
          mime: a.mimeType,
          url: a.dataUrl,
          filename: a.filename,
        })),
      })),
    })
    promoteProjectForConversation(currentSessionDirectory, get().availableWorktreesByProject)
    if (targetSessionId) {
      applyArmedGoal(targetSessionId, currentSessionDirectory)
    }
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: async (title, directoryOverride, parentID, metadata) => {
    const draft = get().newSessionDraft
    const targetFolderId = draft.targetFolderId
    const hadDraft = draft.open
    const draftSnapshot = hadDraft ? { ...draft } : null

    get().closeNewSessionDraft()

    try {
      const dir = directoryOverride ?? opencodeClient.getDirectory()
      const session = await createSessionAction(title, dir, parentID ?? null, metadata)
      if (!session) {
        if (draftSnapshot && !get().newSessionDraft.open && !get().currentSessionId) {
          set({ newSessionDraft: { ...draftSnapshot, draftSubmitting: false, draftEstablishing: false } })
          writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: { ...draftSnapshot, draftSubmitting: false, draftEstablishing: false } })
        }
        return null
      }

      if (targetFolderId) {
        const scopeKey = directoryOverride || get().lastLoadedDirectory || session.directory
        if (scopeKey) {
          useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, session.id)
        }
      }

      return session
    } catch (e) {
      console.error("[session-ui-store] createSession failed", e)
      if (draftSnapshot && !get().newSessionDraft.open && !get().currentSessionId) {
        set({ newSessionDraft: { ...draftSnapshot, draftSubmitting: false, draftEstablishing: false } })
        writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: { ...draftSnapshot, draftSubmitting: false, draftEstablishing: false } })
      }
      return null
    }
  },

  // ---------------------------------------------------------------------------
  // deleteSession — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  deleteSession: (id) => deleteSessionAction(id),

  deleteSessions: async (ids) => {
    const deletedIds: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      const ok = await deleteSessionAction(id)
      if (ok) deletedIds.push(id)
      else failedIds.push(id)
    }
    return { deletedIds, failedIds }
  },

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: async (ids) => {
    const archivedIds: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      const ok = await archiveSessionAction(id)
      if (ok) archivedIds.push(id)
      else failedIds.push(id)
    }
    return { archivedIds, failedIds }
  },

  // ---------------------------------------------------------------------------
  // updateSessionTitle — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  updateSessionTitle: async (sessionId, title) => {
    await updateSessionTitleAction(sessionId, title)
  },

  shareSession: async (sessionId) => {
    return shareSessionAction(sessionId)
  },

  unshareSession: async (sessionId) => {
    return unshareSessionAction(sessionId)
  },

  // ---------------------------------------------------------------------------
  // revertToMessage — delegates to session-actions (single implementation)
  // ---------------------------------------------------------------------------
  revertToMessage: async (sessionId, messageId) => {
    // Ensure the complete message range is present before applying the revert
    // marker. Reverted UI is derived from session.revert + stored messages.
    await refetchSessionMessages(sessionId)
    await revertToMessageAction(sessionId, messageId)
  },

  editMessagePreservingChanges: (sessionId, messageId, snapshot) => {
    stageMessageEdit(sessionId, messageId, snapshot)
    set({ stagedMessageEdit: { sessionId, messageId } })
  },

  // ---------------------------------------------------------------------------
  // handleSlashUndo — reads from sync, records history for redo
  // ---------------------------------------------------------------------------
  handleSlashUndo: async (sessionId) => {
    const messages = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return

    const revertToId = currentSession?.revert?.messageID
    let targetMessage: typeof messages[number] | undefined
    if (revertToId) {
      targetMessage = [...userMessages].reverse().find((m) => m.id < revertToId)
    } else {
      targetMessage = userMessages[userMessages.length - 1]
    }

    if (!targetMessage) return

    // Read target message parts BEFORE calling revertToMessage.
    // revertToMessage optimistically deletes messages from the sync store
    // before the API call, so getSyncParts must run first.
    const targetParts = getSyncParts(targetMessage.id)
    const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
    const preview = textPart?.text
      ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
      : "[No text]"

    // revertToMessage handles the redo stack push internally
    await get().revertToMessage(sessionId, targetMessage.id)

    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    const { dictionary } = useI18nStore.getState()
    toast.success(formatMessage(dictionary, "chat.revert.toast.undo", { preview }))
  },

  // ---------------------------------------------------------------------------
  // handleSlashRedo — moves the authoritative revert marker forward
  // ---------------------------------------------------------------------------
  handleSlashRedo: async (sessionId, options) => {
    if (options?.fullUnrevert) {
      const { unrevertSession } = await import("./session-actions")
      await unrevertSession(sessionId)
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.restored"))
      return
    }

    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    await refetchSessionMessages(sessionId)
    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const targetMessage = userMessages.find((m) => m.id > revertToId)

    if (targetMessage) {
      await get().revertToMessage(sessionId, targetMessage.id, { skipRedoPush: true })
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.redo"))
      return
    }

    await unrevertSessionAction(sessionId)
    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    const { dictionary } = useI18nStore.getState()
    toast.success(formatMessage(dictionary, "chat.revert.toast.restored"))
  },

  // ---------------------------------------------------------------------------
  // forkFromMessage — delegates to session-actions (handles text + sidebar)
  // ---------------------------------------------------------------------------
  forkFromMessage: async (sessionId, messageId) => {
    const activeTransition = get().forkTransition
    console.info("[session-fork] forkFromMessage invoked", {
      sessionId,
      messageId,
      activeOperationId: activeTransition?.operationId ?? null,
      activeStage: activeTransition?.stage ?? null,
    })
    if (activeTransition) {
      console.warn("[session-fork] forkFromMessage skipped because a transition is active", {
        sessionId,
        messageId,
        activeOperationId: activeTransition.operationId,
        activeSourceSessionId: activeTransition.sourceSessionId,
        activeStage: activeTransition.stage,
      })
      return
    }
    // Title is best-effort for the success toast. Cold start may only have the
    // session in the global index — forkSession hydrates the live child store.
    const existingSession = resolveForkSourceSessionSnapshot(sessionId)
    const operationId = ++nextForkOperationId

    try {
      const directory = get().getDirectoryForSession(sessionId)
        ?? opencodeClient.getDirectory()
        ?? ""
      if (!directory) {
        console.warn("[session-fork] forkFromMessage missing directory", {
          sessionId,
          messageId,
        })
        const { toast } = await import("sonner")
        toast.error("Failed to fork session")
        return
      }
      console.info("[session-fork] forkFromMessage starting transition", {
        operationId,
        sessionId,
        messageId,
        hasDirectory: Boolean(directory),
        hasLocalSnapshot: Boolean(existingSession),
      })
      set({
        forkTransition: {
          operationId,
          sourceSessionId: sessionId,
          directory,
          stage: "preparing",
        },
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const completed = await forkSessionAction(sessionId, operationId, messageId)
      if (!completed) {
        console.warn("[session-fork] forkFromMessage ended before completion", {
          operationId,
          sessionId,
          messageId,
        })
        return
      }

      const { toast } = await import("sonner")
      console.info("[session-fork] forkFromMessage completed", {
        operationId,
        sessionId,
        messageId,
      })
      toast.success(`Forked from ${existingSession?.title ?? "session"}`)
    } catch (error) {
      console.error("[session-fork] forkFromMessage failed", {
        operationId,
        sessionId,
        messageId,
        error,
      })
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    } finally {
      set((state) => state.forkTransition?.operationId === operationId
        ? { forkTransition: null }
        : state)
    }
  },

  forkCurrentSession: async (sessionId) => {
    const activeTransition = get().forkTransition
    console.info("[session-fork] forkCurrentSession invoked", {
      sessionId,
      activeOperationId: activeTransition?.operationId ?? null,
      activeStage: activeTransition?.stage ?? null,
    })
    if (activeTransition) {
      console.warn("[session-fork] forkCurrentSession skipped because a transition is active", {
        sessionId,
        activeOperationId: activeTransition.operationId,
        activeSourceSessionId: activeTransition.sourceSessionId,
        activeStage: activeTransition.stage,
      })
      return
    }
    const existingSession = resolveForkSourceSessionSnapshot(sessionId)
    const operationId = ++nextForkOperationId

    try {
      const directory = get().getDirectoryForSession(sessionId)
        ?? opencodeClient.getDirectory()
        ?? ""
      if (!directory) {
        console.warn("[session-fork] forkCurrentSession missing directory", {
          sessionId,
        })
        const { toast } = await import("sonner")
        toast.error("Failed to fork session")
        return
      }
      console.info("[session-fork] forkCurrentSession starting transition", {
        operationId,
        sessionId,
        hasDirectory: Boolean(directory),
        hasLocalSnapshot: Boolean(existingSession),
      })
      set({
        forkTransition: {
          operationId,
          sourceSessionId: sessionId,
          directory,
          stage: "preparing",
        },
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const completed = await forkSessionAction(sessionId, operationId)
      if (!completed) {
        console.warn("[session-fork] forkCurrentSession ended before completion", {
          operationId,
          sessionId,
        })
        return
      }

      const { toast } = await import("sonner")
      console.info("[session-fork] forkCurrentSession completed", {
        operationId,
        sessionId,
      })
      toast.success(`Forked from ${existingSession?.title ?? "session"}`)
    } catch (error) {
      console.error("[session-fork] forkCurrentSession failed", {
        operationId,
        sessionId,
        error,
      })
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    } finally {
      set((state) => state.forkTransition?.operationId === operationId
        ? { forkTransition: null }
        : state)
    }
  },

  // ---------------------------------------------------------------------------
  // Data access helpers — read from sync
  // ---------------------------------------------------------------------------
  getSessionsByDirectory: (directory) => {
    const nd = normalizePath(directory)
    if (!nd) return []
    const sessions = getAllSyncSessions()
    return sessions.filter((s) => resolveDirectoryKey(s) === nd)
  },

  getAuthoritativeDirectoryForSession: (sessionId) => {
    const resolved = resolveSessionDirectory(
      sessionId,
      (sid) => get().worktreeMetadata.get(sid),
      { includeRuntimeMemory: false },
    )
    if (resolved) return resolved
    const globalStore = useGlobalSessionsStore.getState()
    const globalSession = [...globalStore.activeSessions, ...globalStore.archivedSessions]
      .find((s) => s.id === sessionId)
    return globalSession ? resolveGlobalSessionDirectory(globalSession) : null
  },

  getDirectoryForSession: (sessionId) => {
    if (sessionId === get().currentSessionId && get().currentSessionDirectory) {
      return get().currentSessionDirectory
    }
    const resolved = resolveSessionDirectory(sessionId, (sid) => get().worktreeMetadata.get(sid))
    if (resolved) return resolved
    return get().getAuthoritativeDirectoryForSession(sessionId)
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as Message & {
        model?: { providerID?: string; modelID?: string; variant?: string }
        variant?: string
        mode?: string
      }
      if (message.role !== "user") {
        continue
      }

      const providerID = typeof message.model?.providerID === "string" && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined
      const modelID = typeof message.model?.modelID === "string" && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined
      const agent = typeof message.agent === "string" && message.agent.trim().length > 0
        ? message.agent
        : (typeof message.mode === "string" && message.mode.trim().length > 0 ? message.mode : undefined)
      const variantCandidate = message.model?.variant ?? message.variant
      const variant = typeof variantCandidate === "string" && variantCandidate.trim().length > 0
        ? variantCandidate
        : undefined

      return { agent, providerID, modelID, variant }
    }
    return null
  },

  getCurrentAgent: (sessionId) => {
    return useSelectionStore.getState().sessionAgentSelections.get(sessionId) ?? undefined
  },

  debugSessionMessages: async (sessionId) => {
    const msgs = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    console.log(`Debug session ${sessionId}:`, {
      session,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        tokens: m.role === "assistant" ? m.tokens : undefined,
      })),
    })
  },

  pollForTokenUpdates: () => {
    // Handled by sync system's SSE stream
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    if (sessionId === get().currentSessionId) {
      set({ currentSessionDirectory: normalized })
      writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId, directory: normalized })
    }
  },

  // ---------------------------------------------------------------------------
  // Plan mode availability tracking
  // ---------------------------------------------------------------------------
  markSessionPlanAvailable: (sessionId) => {
    set((state) => {
      if (state.sessionPlanAvailable.get(sessionId) === true) {
        return state
      }
      const next = new Map(state.sessionPlanAvailable)
      next.set(sessionId, true)
      return { sessionPlanAvailable: next }
    })
  },

  isSessionPlanAvailable: (sessionId) => {
    return get().sessionPlanAvailable.get(sessionId) ?? false
  },
}))

setSessionOpener((sessionID, directory) => {
  useSessionUIStore.getState().setCurrentSession(sessionID, directory)
})

// Write-through persist of the worktree map whenever discovery refreshes it.
// Reference-equality guard filters hot session updates; the serialized
// comparison avoids redundant localStorage writes when the Map reference
// changed but the content is identical (e.g., re-discovery that found the
// same worktrees).
let lastPersistedWorktreeSerialized = ''
useSessionUIStore.subscribe((state, prev) => {
  if (state.availableWorktreesByProject !== prev.availableWorktreesByProject) {
    const serialized = JSON.stringify([...state.availableWorktreesByProject.entries()])
    if (serialized !== lastPersistedWorktreeSerialized) {
      lastPersistedWorktreeSerialized = serialized
      persistWorktreeMap(serialized)
    }
  }
})
