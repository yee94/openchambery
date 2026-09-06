/**
 * Regression: draft → claimed real session transcript handoff continuity.
 *
 * User report: after creating a new conversation, the just-sent user message
 * repeatedly disappears / jumps while hydration races the real session.
 *
 * This file locks the **data + gate** contract ChatContainer uses across that
 * handover (not model-header / spacing chrome — designer-owned):
 *
 * 1. Establishing paints draft.pendingUserMessage (no session id yet).
 * 2. createWithPrompt ack retains the same message ID under the real session
 *    *before* selection closes the draft (public sendMessage path).
 * 3. Empty / part-less / synthetic-only authoritative reads keep the retained
 *    presentation via mergePendingUserMessagePresentations and pass the cold
 *    transcript gate (hasImmediateShell) — never skeleton / empty welcome.
 * 4. Displayable authoritative same-ID user row replaces pending; clear drops
 *    retention only then. Assistant may land after without blanking the user.
 * 5. Create failure restores draft and never retains under a phantom session.
 * 6. Runtime switch clears retainedPendingUserMessages; other-session selection
 *    never paints session A's retained rows under session B.
 *
 * Verdict target: prove whether retained pending already closes the display
 * gap, or whether an independent data/gate defect remains.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2'

import {
  hasChatTranscriptShell,
  mergePendingUserMessagePresentations,
  pendingUserMessagesImplyWorking,
  resolveChatSessionTranscriptGate,
  resolveRetainedTranscript,
} from './chatContainerHost'
import { hasUserDisplayableParts } from './message/normalizeUserDisplayParts'
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry'
import { opencodeClient } from '@/lib/opencode/client'
import type {
  ConversationCreateWithPromptInput,
  ConversationCreateWithPromptResult,
  RuntimeAPIs,
} from '@/lib/api/types'
import { queryClient } from '@/lib/queryRuntime'
import { useDirectoryStore } from '@/stores/useDirectoryStore'
import { useConfigStore } from '@/stores/useConfigStore'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { useProjectsStore } from '@/stores/useProjectsStore'
import {
  combinedSendConfirmationOptions,
  resetCombinedSendConfirmationOptions,
  setActionRefs,
  setOptimisticRefs,
} from '@/sync/session-actions'
import { useInputStore } from '@/sync/input-store'
import { useSelectionStore } from '@/sync/selection-store'
import {
  createPendingUserMessagePresentation,
  useSessionUIStore,
  type PendingUserMessagePresentation,
} from '@/sync/session-ui-store'

// ─── ChatContainer-equivalent viewport pipeline ─────────────────────────────
//
// Mirrors ChatContainer.tsx: pending merge → retained empty-read buffer → cold
// transcript gate. Kept local so this test fails if the host helpers drift
// without requiring a full ChatContainer mount.

type SessionMessageRecord = { info: Message; parts: Part[] }

type ViewportFrame = {
  sessionId: string | null
  /** Authoritative repository/sync rows for the current session. */
  sessionMessages: readonly SessionMessageRecord[]
  /** host pending ∪ retained pending for currentSessionId (ChatContainer memo). */
  pendingUserMessages: readonly PendingUserMessagePresentation[]
  historyPrefixCount?: number
  prefetchStatus?: 'loading' | 'ready' | 'error'
  syncLoading?: boolean
  hasRenderableSessionSnapshot?: boolean
  p0Satisfied?: boolean
  sessionStatus?: { type?: string } | null
  sessionStatusObservedAt?: number | null
  paintedSessionId?: string | null
  retainedPaint?: { sessionId: string; messages: readonly SessionMessageRecord[] } | null
}

type ViewportPaint = {
  gate: 'pass' | 'hydrating' | 'load-error'
  viewportMessages: readonly SessionMessageRecord[]
  renderedMessages: readonly SessionMessageRecord[]
  hasTranscriptShell: boolean
  sessionIsWorking: boolean
  /** IDs ChatContainer would clear from retainedPendingUserMessages. */
  materializedPendingMessageIDs: string[]
  wouldShowHydratingSkeleton: boolean
  wouldShowEmptyWelcome: boolean
  /** Draft establishing page still owns paint (no real session yet). */
  wouldShowDraftEstablishing: boolean
}

function resolveViewportPaint(frame: ViewportFrame & {
  draftOpen?: boolean
  draftSubmitting?: boolean
  draftEstablishing?: boolean
  draftPendingMessage?: PendingUserMessagePresentation | null
}): ViewportPaint {
  const {
    sessionId,
    sessionMessages,
    pendingUserMessages,
    historyPrefixCount = 0,
    prefetchStatus,
    syncLoading = false,
    hasRenderableSessionSnapshot = false,
    p0Satisfied = false,
    sessionStatus = null,
    sessionStatusObservedAt = null,
    paintedSessionId = null,
    retainedPaint = null,
    draftOpen = false,
    draftSubmitting = false,
    draftEstablishing = false,
    draftPendingMessage = null,
  } = frame

  // ChatContainer: !currentSessionId && draftOpen && (submitting|establishing) && pending
  if (!sessionId && draftOpen && (draftSubmitting || draftEstablishing) && draftPendingMessage) {
    return {
      gate: 'pass',
      viewportMessages: [draftPendingMessage],
      renderedMessages: [draftPendingMessage],
      hasTranscriptShell: true,
      sessionIsWorking: true,
      materializedPendingMessageIDs: [],
      wouldShowHydratingSkeleton: false,
      wouldShowEmptyWelcome: false,
      wouldShowDraftEstablishing: true,
    }
  }

  const viewportMessages = mergePendingUserMessagePresentations(
    sessionMessages as SessionMessageRecord[],
    pendingUserMessages,
  )
  const retained = resolveRetainedTranscript({
    sessionId,
    messages: viewportMessages,
    retained: retainedPaint,
  })
  const renderedMessages = retained.messages as SessionMessageRecord[]

  const hasTranscriptShell = hasChatTranscriptShell({
    transcriptMessageCount: sessionMessages.length,
    pendingUserCount: pendingUserMessages.length,
    historyPrefixCount,
  })
  const sessionIsWorkingFromStatus = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry'
  const sessionIsWorking = sessionIsWorkingFromStatus
    || pendingUserMessagesImplyWorking(pendingUserMessages, {
      resolvedSessionStatus: sessionStatus,
      sessionStatusObservedAt,
    })

  const gate = resolveChatSessionTranscriptGate({
    hasTranscriptShell,
    p0Satisfied,
    hasBusyShell: sessionIsWorking && hasTranscriptShell,
    hasImmediateShell: pendingUserMessages.length > 0 || historyPrefixCount > 0,
    hasRenderableSessionSnapshot,
    prefetchStatus,
    syncLoading,
    hasPaintedTranscript: paintedSessionId === sessionId && Boolean(sessionId),
  })

  const authoritativeDisplayable = new Set(
    sessionMessages
      .filter((message) => hasUserDisplayableParts(message.parts))
      .map((message) => message.info.id),
  )
  const materializedPendingMessageIDs = pendingUserMessages
    .map((message) => message.info.id)
    .filter((id) => authoritativeDisplayable.has(id))

  const wouldShowHydratingSkeleton = Boolean(sessionId) && gate === 'hydrating'
  // ChatContainer empty branch: rendered empty && !sessionIsWorking (after gate pass).
  const wouldShowEmptyWelcome = Boolean(sessionId)
    && gate === 'pass'
    && renderedMessages.length === 0
    && !sessionIsWorking

  return {
    gate,
    viewportMessages,
    renderedMessages,
    hasTranscriptShell,
    sessionIsWorking,
    materializedPendingMessageIDs,
    wouldShowHydratingSkeleton,
    wouldShowEmptyWelcome,
    wouldShowDraftEstablishing: false,
  }
}

function userText(message: SessionMessageRecord | PendingUserMessagePresentation | undefined): string | undefined {
  const part = message?.parts.find((entry) => entry.type === 'text' && typeof (entry as Part & { text?: string }).text === 'string')
  return part && 'text' in part ? String((part as { text: string }).text) : undefined
}

// ─── Combined-send harness (public sendMessage path) ────────────────────────

const PROJECT = { id: 'proj-handoff', path: '/projects/handoff', label: 'Handoff' }
const SESSION_ID = 'ses_handoff_001'
const OTHER_SESSION_ID = 'ses_handoff_other'

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    slug: 'handoff-test',
    projectID: 'proj-handoff',
    directory: PROJECT.path,
    title: 'Handoff Test',
    time: { created: Date.now(), updated: Date.now() },
    version: '1',
    ...overrides,
  } as any
}

function successResult(mid: string): ConversationCreateWithPromptResult {
  return { ok: true, session: sessionFixture(), messageID: mid }
}

function failResult(phase: 'create' | 'validate'): ConversationCreateWithPromptResult {
  return phase === 'create'
    ? { ok: false, phase: 'create', error: 'test create' }
    : { ok: false, phase: 'validate', error: 'test validate', errors: ['test validate'] }
}

function makeCombinedAPI(
  fn: (input: ConversationCreateWithPromptInput) => Promise<ConversationCreateWithPromptResult>,
): RuntimeAPIs {
  return {
    conversations: { createWithPrompt: fn },
    runtime: { platform: 'web' as const, isDesktop: false, isVSCode: false },
    terminal: {} as any,
    git: {} as any,
    files: {} as any,
    settings: {} as any,
    permissions: {} as any,
    notifications: {} as any,
    tools: {} as any,
  } as RuntimeAPIs
}

function createChildStore() {
  const messageMap: Record<string, any[]> = {}
  const statusMap: Record<string, any> = {}
  const statusObservedAtMap: Record<string, number> = {}
  const partMap: Record<string, any[]> = {}
  const snapshot = () => ({
    session: [] as any[],
    message: messageMap,
    session_status: statusMap,
    session_status_observed_at: statusObservedAtMap,
    part: partMap,
  })
  const apply = (next: any) => {
    if (!next || next === snapshot()) return
    if (next.session_status && next.session_status !== statusMap) {
      for (const key of Object.keys(statusMap)) delete statusMap[key]
      Object.assign(statusMap, next.session_status)
    }
    if (next.session_status_observed_at && next.session_status_observed_at !== statusObservedAtMap) {
      for (const key of Object.keys(statusObservedAtMap)) delete statusObservedAtMap[key]
      Object.assign(statusObservedAtMap, next.session_status_observed_at)
    }
    if (next.message && next.message !== messageMap) {
      for (const key of Object.keys(messageMap)) delete messageMap[key]
      Object.assign(messageMap, next.message)
    }
    if (next.part && next.part !== partMap) {
      for (const key of Object.keys(partMap)) delete partMap[key]
      Object.assign(partMap, next.part)
    }
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getState: snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setState: (patch: any) => {
      if (typeof patch === 'function') {
        apply(patch(snapshot()))
        notify()
        return
      }
      if (patch.session_status) Object.assign(statusMap, patch.session_status)
      if (patch.session_status_observed_at) Object.assign(statusObservedAtMap, patch.session_status_observed_at)
      if (patch.message) Object.assign(messageMap, patch.message)
      if (patch.part) Object.assign(partMap, patch.part)
      notify()
    },
  }
}

let originalBuildMessageParts: typeof opencodeClient.buildMessageParts
let originalGetDirectory: typeof opencodeClient.getDirectory
let originalFetch: typeof globalThis.fetch
let sessionMessagesHandler: (params: any) => Promise<any> | any = async () => {
  throw new Error('session.messages not mocked')
}

function makeActionSdk() {
  return {
    ...opencodeClient,
    session: {
      ...((opencodeClient as any).session ?? {}),
      messages: async (params: any) => sessionMessagesHandler(params),
    },
  }
}

function setupChildStores(dir = PROJECT.path) {
  const childStore = createChildStore()
  const childStores = {
    children: new Map<string, typeof childStore>(),
    ensureChild: (d: string) => {
      if (!childStores.children.has(d)) childStores.children.set(d, childStore)
      return childStores.children.get(d)!
    },
    getChild: (d: string) => childStores.children.get(d) ?? childStore,
  }
  setActionRefs(makeActionSdk() as any, childStores as any, () => dir)
  setOptimisticRefs(null as any, null as any)
  return { childStore }
}

function resetAll() {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: {
      open: false,
      draftID: null,
      directoryOverride: null,
      parentID: null,
      draftSubmitting: false,
    },
    availableWorktreesByProject: new Map(),
    webUICreatedSessions: new Set<string>(),
    retainedPendingUserMessages: new Map(),
  })
  useInputStore.setState({ pendingInputText: null, pendingInputMode: 'replace', attachedFiles: [] })
  useConfigStore.setState({
    isConnected: true,
    currentAgentName: undefined,
    currentProviderId: 'openai',
    currentModelId: 'gpt-4o',
    agents: [],
  } as any)
  useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id })
  useDirectoryStore.setState({ currentDirectory: PROJECT.path })
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] })
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
  } as any)
  registerRuntimeAPIs(null)
}

beforeEach(() => {
  originalBuildMessageParts = opencodeClient.buildMessageParts
  originalGetDirectory = opencodeClient.getDirectory
  originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch
  opencodeClient.buildMessageParts = async (params: any) => {
    const parts: any[] = []
    if (params.text?.trim()) parts.push({ type: 'text', text: params.text.trim() })
    return parts
  }
  opencodeClient.getDirectory = () => PROJECT.path
  resetAll()
  sessionMessagesHandler = async () => ({ data: [] })
  setupChildStores()
  combinedSendConfirmationOptions.presenceGraceMs = 10
  combinedSendConfirmationOptions.recovery = { attempts: 1, retryDelayMs: 0 }
  queryClient.clear()
})

afterEach(async () => {
  opencodeClient.buildMessageParts = originalBuildMessageParts
  opencodeClient.getDirectory = originalGetDirectory
  globalThis.fetch = originalFetch
  registerRuntimeAPIs(null)
  setActionRefs(null as any, null as any, () => '')
  setOptimisticRefs(null as any, null as any)
  resetCombinedSendConfirmationOptions()
  await new Promise((resolve) => setTimeout(resolve, 0))
  queryClient.clear()
})

// ─── Pure pipeline sequence (authoritative ChatContainer gate/merge) ────────

describe('draft transcript handoff — gate/merge continuity', () => {
  const messageID = 'msg_handoff_user'
  const body = 'first turn continuity'

  const draftPending = createPendingUserMessagePresentation({
    messageID,
    sessionID: 'draft:pending',
    providerID: 'openai',
    modelID: 'gpt-4o',
    text: body,
  })

  const retained = createPendingUserMessagePresentation({
    messageID,
    sessionID: SESSION_ID,
    providerID: 'openai',
    modelID: 'gpt-4o',
    text: body,
  })

  test('sequence: establishing → empty hydration → partless → authoritative user → assistant', () => {
    // 1) Establishing (no session): draft page owns the optimistic user row.
    const establishing = resolveViewportPaint({
      sessionId: null,
      sessionMessages: [],
      pendingUserMessages: [],
      draftOpen: true,
      draftEstablishing: true,
      draftPendingMessage: draftPending,
    })
    expect(establishing.wouldShowDraftEstablishing).toBe(true)
    expect(userText(establishing.renderedMessages[0])).toBe(body)
    expect(establishing.wouldShowHydratingSkeleton).toBe(false)
    expect(establishing.wouldShowEmptyWelcome).toBe(false)

    // 2) Claimed session, store empty, prefetch still loading — retained pending
    // is the only shell. Gate must pass; skeleton/empty must not flash.
    const emptyHydration = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [],
      pendingUserMessages: [retained],
      prefetchStatus: 'loading',
      syncLoading: true,
      hasRenderableSessionSnapshot: false,
      p0Satisfied: false,
      sessionStatus: { type: 'busy' },
      sessionStatusObservedAt: Date.now(),
    })
    expect(emptyHydration.gate).toBe('pass')
    expect(emptyHydration.hasTranscriptShell).toBe(true)
    expect(emptyHydration.wouldShowHydratingSkeleton).toBe(false)
    expect(emptyHydration.wouldShowEmptyWelcome).toBe(false)
    expect(emptyHydration.renderedMessages).toHaveLength(1)
    expect(emptyHydration.renderedMessages[0]?.info.id).toBe(messageID)
    expect(userText(emptyHydration.renderedMessages[0])).toBe(body)
    expect(emptyHydration.materializedPendingMessageIDs).toEqual([])

    // 3) Part-less authoritative shell must not clear retained / paint empty bubble.
    const partless: SessionMessageRecord = {
      info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } } as Message,
      parts: [],
    }
    const partlessFrame = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [partless],
      pendingUserMessages: [retained],
      prefetchStatus: 'loading',
      syncLoading: true,
      sessionStatus: { type: 'busy' },
      sessionStatusObservedAt: Date.now(),
      paintedSessionId: SESSION_ID,
      retainedPaint: { sessionId: SESSION_ID, messages: emptyHydration.renderedMessages },
    })
    expect(partlessFrame.gate).toBe('pass')
    expect(partlessFrame.renderedMessages).toHaveLength(1)
    expect(userText(partlessFrame.renderedMessages[0])).toBe(body)
    expect(hasUserDisplayableParts(partless.parts)).toBe(false)
    expect(partlessFrame.materializedPendingMessageIDs).toEqual([])

    // 4) Displayable authoritative same-ID user replaces pending; clear IDs fire.
    const authoritativeUser: SessionMessageRecord = {
      info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } } as Message,
      parts: [{ id: 'prt_u', type: 'text', text: body, messageID, sessionID: SESSION_ID } as Part],
    }
    const authUserFrame = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [authoritativeUser],
      pendingUserMessages: [retained],
      prefetchStatus: 'ready',
      hasRenderableSessionSnapshot: true,
      p0Satisfied: true,
      sessionStatus: { type: 'busy' },
      sessionStatusObservedAt: Date.now(),
      paintedSessionId: SESSION_ID,
    })
    expect(authUserFrame.gate).toBe('pass')
    expect(authUserFrame.renderedMessages).toHaveLength(1)
    expect(authUserFrame.renderedMessages[0]).toBe(authoritativeUser)
    expect(authUserFrame.materializedPendingMessageIDs).toEqual([messageID])

    // After clear, pending empty — authoritative alone still shells.
    const clearedPending = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [authoritativeUser],
      pendingUserMessages: [],
      prefetchStatus: 'ready',
      hasRenderableSessionSnapshot: true,
      p0Satisfied: true,
      sessionStatus: { type: 'busy' },
      paintedSessionId: SESSION_ID,
    })
    expect(clearedPending.renderedMessages).toEqual([authoritativeUser])
    expect(clearedPending.wouldShowEmptyWelcome).toBe(false)

    // 5) Assistant arrives; user row stays.
    const assistant: SessionMessageRecord = {
      info: { id: 'msg_handoff_assistant', role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } } as Message,
      parts: [{ id: 'prt_a', type: 'text', text: 'ok', messageID: 'msg_handoff_assistant', sessionID: SESSION_ID } as Part],
    }
    const withAssistant = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [authoritativeUser, assistant],
      pendingUserMessages: [],
      prefetchStatus: 'ready',
      hasRenderableSessionSnapshot: true,
      p0Satisfied: true,
      sessionStatus: { type: 'busy' },
      paintedSessionId: SESSION_ID,
    })
    expect(withAssistant.renderedMessages.map((m) => m.info.id)).toEqual([messageID, 'msg_handoff_assistant'])
    expect(userText(withAssistant.renderedMessages[0])).toBe(body)
  })

  test('without retained pending, empty hydration still blanks (documents the original gap)', () => {
    // Control: if retain never landed, cold empty + loading is skeleton — the
    // pre-fix gap. Current production must not take this path after claim.
    const blank = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [],
      pendingUserMessages: [],
      prefetchStatus: 'loading',
      syncLoading: true,
      hasRenderableSessionSnapshot: false,
      p0Satisfied: false,
    })
    expect(blank.gate).toBe('hydrating')
    expect(blank.wouldShowHydratingSkeleton).toBe(true)
    expect(blank.renderedMessages).toHaveLength(0)
  })

  test('other session selection never paints retained rows from the claimed session', () => {
    const otherPaint = resolveViewportPaint({
      sessionId: OTHER_SESSION_ID,
      sessionMessages: [],
      // ChatContainer only subscribes retained for *current* session id.
      pendingUserMessages: [],
      prefetchStatus: 'loading',
      syncLoading: true,
      retainedPaint: {
        sessionId: SESSION_ID,
        messages: [retained],
      },
    })
    // resolveRetainedTranscript drops cross-session retention.
    expect(otherPaint.renderedMessages).toHaveLength(0)
    expect(otherPaint.gate).toBe('hydrating')
  })

  test('transient empty read after paint replays retained transcript (no 0→N re-pin shell loss)', () => {
    const painted = [retained] as SessionMessageRecord[]
    const emptyRead = resolveViewportPaint({
      sessionId: SESSION_ID,
      sessionMessages: [],
      pendingUserMessages: [],
      prefetchStatus: 'loading',
      syncLoading: true,
      paintedSessionId: SESSION_ID,
      retainedPaint: { sessionId: SESSION_ID, messages: painted },
    })
    expect(emptyRead.gate).toBe('pass')
    expect(emptyRead.renderedMessages).toBe(painted)
    expect(emptyRead.wouldShowHydratingSkeleton).toBe(false)
  })
})

// ─── Public sendMessage + store retention ───────────────────────────────────

describe('draft transcript handoff — sendMessage public action', () => {
  test('happy path retains same message ID under claimed session before draft closes', async () => {
    const messageID = 'msg_handoff_public'
    let resolveCreate!: (value: ConversationCreateWithPromptResult) => void
    const deferred = new Promise<ConversationCreateWithPromptResult>((resolve) => {
      resolveCreate = resolve
    })
    registerRuntimeAPIs(makeCombinedAPI(async (input) => deferred.then(() => successResult(input.messageID!))))

    useSessionUIStore.getState().openNewSessionDraft()
    const sendPromise = useSessionUIStore.getState().sendMessage(
      'public handoff',
      'openai',
      'gpt-4o',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      'normal',
      { messageID },
    )

    // Establishing: draft owns pending presentation.
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(true)
    const draftPending = useSessionUIStore.getState().newSessionDraft.pendingUserMessage
    expect(draftPending?.info.id).toBe(messageID)
    expect(userText(draftPending)).toBe('public handoff')
    expect(useSessionUIStore.getState().retainedPendingUserMessages.size).toBe(0)

    const establishingPaint = resolveViewportPaint({
      sessionId: null,
      sessionMessages: [],
      pendingUserMessages: [],
      draftOpen: true,
      draftSubmitting: true,
      draftPendingMessage: draftPending ?? null,
    })
    expect(establishingPaint.wouldShowDraftEstablishing).toBe(true)
    expect(userText(establishingPaint.renderedMessages[0])).toBe('public handoff')

    resolveCreate(successResult(messageID))
    await sendPromise

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe(SESSION_ID)
    expect(state.newSessionDraft.open).toBe(false)
    expect(state.newSessionDraft.pendingUserMessage).toBe(undefined)

    const retained = state.retainedPendingUserMessages.get(SESSION_ID) ?? []
    expect(retained.map((m) => m.info.id)).toEqual([messageID])
    expect(retained[0]?.info.sessionID).toBe(SESSION_ID)
    expect(userText(retained[0])).toBe('public handoff')

    // Claimed + empty store + loading: retained must keep the row on screen.
    const claimedPaint = resolveViewportPaint({
      sessionId: state.currentSessionId,
      sessionMessages: [],
      pendingUserMessages: retained,
      prefetchStatus: 'loading',
      syncLoading: true,
      hasRenderableSessionSnapshot: false,
      sessionStatus: { type: 'busy' },
      sessionStatusObservedAt: Date.now(),
    })
    expect(claimedPaint.gate).toBe('pass')
    expect(claimedPaint.wouldShowHydratingSkeleton).toBe(false)
    expect(claimedPaint.wouldShowEmptyWelcome).toBe(false)
    expect(claimedPaint.renderedMessages).toHaveLength(1)
    expect(claimedPaint.renderedMessages[0]?.info.id).toBe(messageID)
    expect(userText(claimedPaint.renderedMessages[0])).toBe('public handoff')
  })

  test('create failure restores draft and never retains a session-keyed pending row', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => failResult('create')))
    useSessionUIStore.getState().openNewSessionDraft()

    let caught = false
    try {
      await useSessionUIStore.getState().sendMessage('will fail', 'openai', 'gpt-4o')
    } catch {
      caught = true
    }
    expect(caught).toBe(true)

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe(null)
    expect(state.newSessionDraft.open).toBe(true)
    expect(state.newSessionDraft.draftSubmitting).toBe(false)
    expect(state.newSessionDraft.pendingUserMessage).toBe(undefined)
    expect(state.retainedPendingUserMessages.size).toBe(0)
    expect(useInputStore.getState().pendingInputText).toBe('will fail')
  })

  test('runtime switch clears retained pending map', async () => {
    const messageID = 'msg_handoff_runtime_clear'
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID!)))
    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage(
      'runtime clear',
      'openai',
      'gpt-4o',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      'normal',
      { messageID },
    )
    expect(useSessionUIStore.getState().retainedPendingUserMessages.has(SESSION_ID)).toBe(true)

    useSessionUIStore.getState().prepareForRuntimeSwitch('http://runtime-b.test')
    useSessionUIStore.getState().restoreForRuntimeSwitch('http://runtime-b.test')

    expect(useSessionUIStore.getState().retainedPendingUserMessages.size).toBe(0)
  })

  test('switching current session does not expose other session retained rows to the gate', async () => {
    const messageID = 'msg_handoff_switch'
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID!)))
    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage(
      'switch away',
      'openai',
      'gpt-4o',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      'normal',
      { messageID },
    )
    const retainedA = useSessionUIStore.getState().retainedPendingUserMessages.get(SESSION_ID) ?? []
    expect(retainedA).toHaveLength(1)

    // Simulate selecting another session (sidebar). Retained map keeps A, but
    // ChatContainer only reads retained for currentSessionId.
    useSessionUIStore.setState({
      currentSessionId: OTHER_SESSION_ID,
      currentSessionDirectory: PROJECT.path,
    })
    const retainedForCurrent = useSessionUIStore.getState().retainedPendingUserMessages.get(OTHER_SESSION_ID)
    expect(retainedForCurrent).toBe(undefined)

    const otherPaint = resolveViewportPaint({
      sessionId: OTHER_SESSION_ID,
      sessionMessages: [],
      pendingUserMessages: retainedForCurrent ?? [],
      prefetchStatus: 'loading',
      syncLoading: true,
    })
    expect(otherPaint.wouldShowHydratingSkeleton).toBe(true)
    expect(otherPaint.renderedMessages).toHaveLength(0)

    // Map still holds A for when the user returns before materialize.
    expect(useSessionUIStore.getState().retainedPendingUserMessages.get(SESSION_ID)?.[0]?.info.id).toBe(messageID)
  })
})
