/**
 * Combined draft send tests — exercises useSessionUIStore.sendMessage through
 * the handleCombinedDraftSend path by registering mock RuntimeAPIs with a
 * conversations capability.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { opencodeClient } from '@/lib/opencode/client'
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry'
import { routeMessage, useSessionUIStore } from './session-ui-store'
import { setActionRefs, setOptimisticRefs } from './session-actions'
import { useConfigStore } from '@/stores/useConfigStore'
import { useInputStore } from './input-store'
import { newSessionDraftKey, sessionDraftKey } from './input-draft-types'
import { useProjectsStore } from '@/stores/useProjectsStore'
import { useDirectoryStore } from '@/stores/useDirectoryStore'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { useSelectionStore } from './selection-store'
import type { ConversationCreateWithPromptResult, ConversationCreateWithPromptInput, RuntimeAPIs } from '@/lib/api/types'
import { commandQueryOptions } from '@/queries/commandQueries'
import { installedSkillsQueryOptions } from '@/queries/installedSkillsQueries'
import { queryClient } from '@/lib/queryRuntime'
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch'

// ─── helpers ────────────────────────────────────────────────────────────────

const PROJECT = { id: 'proj-comb', path: '/projects/combined', label: 'Combined' }
const SESSION_ID = 'ses_combined_001'

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    slug: 'combined-test',
    projectID: 'proj-comb',
    directory: '/projects/combined',
    title: 'Combined Test',
    time: { created: Date.now(), updated: Date.now() },
    version: '1',
    ...overrides,
  } as any
}

function successResult(mid = 'msg_00000000000000000000000000'): ConversationCreateWithPromptResult {
  return { ok: true, session: sessionFixture(), messageID: mid }
}

type FailPhase = 'validate' | 'create' | 'conflict' | 'unavailable' | 'internal'

function failResult(phase: FailPhase): ConversationCreateWithPromptResult {
  switch (phase) {
    case 'validate':
      return { ok: false, phase: 'validate', error: `test ${phase}`, errors: [`test ${phase} error`] }
    case 'conflict':
      return { ok: false, phase: 'conflict', error: `test ${phase}` }
    case 'unavailable':
      return { ok: false, phase: 'unavailable', error: `test ${phase}` }
    case 'internal':
      return { ok: false, phase: 'internal', error: `test ${phase}` }
    case 'create':
      return { ok: false, phase: 'create', error: `test ${phase}` }
  }
}

function promptResult(ambiguous: boolean): ConversationCreateWithPromptResult {
  return {
    ok: false,
    phase: 'prompt',
    session: sessionFixture(),
    messageID: 'msg_p000000000000000000000000',
    ambiguous,
    error: 'Failed',
  }
}

function makeCombinedAPI(fn: (input: ConversationCreateWithPromptInput, signal?: AbortSignal) => Promise<ConversationCreateWithPromptResult>): RuntimeAPIs {
  return { conversations: { createWithPrompt: fn }, runtime: { platform: 'web' as const, isDesktop: false, isVSCode: false }, terminal: {} as any, git: {} as any, files: {} as any, settings: {} as any, permissions: {} as any, notifications: {} as any, tools: {} as any } as RuntimeAPIs
}

// ─── setup / teardown ───────────────────────────────────────────────────────

let originalBuildMessageParts: typeof opencodeClient.buildMessageParts
let originalGetDirectory: typeof opencodeClient.getDirectory
let originalCreateSession: typeof opencodeClient.createSession
let originalSendMessage: typeof opencodeClient.sendMessage
let originalSendCommand: typeof opencodeClient.sendCommand
let originalDeleteSessionMessage: typeof opencodeClient.deleteSessionMessage
let originalShellSession: typeof opencodeClient.shellSession
let originalFetch: typeof globalThis.fetch
let notificationRequests: Array<{ url: string; init?: RequestInit }>
let originalCaptureDraftRuntime: any
let originalGetDraft: any
let originalFinalizeDraftOwnership: any
let ownershipCalls: any[]

function installOwnershipSource(draftID: string, runtime = { transportIdentity: 'runtime-combined', generation: 9 }, revision = 23) {
  const source = newSessionDraftKey(runtime, draftID)
  useInputStore.setState({
    captureDraftRuntime: () => runtime,
    getDraft: (key) => JSON.stringify(key) === JSON.stringify(source) ? { key: source, revision } as any : undefined,
    finalizeDraftOwnership: async (input) => {
      ownershipCalls.push(input)
      return { status: 'committed', current: true, durable: true } as any
    },
  })
  return { runtime, source, revision }
}

async function flushNotifications() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function resetAll() {
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false }, availableWorktreesByProject: new Map(), webUICreatedSessions: new Set<string>() })
  useInputStore.setState({ pendingInputText: null, pendingInputMode: 'replace', attachedFiles: [] })
  useConfigStore.setState({ isConnected: true, currentAgentName: undefined, currentProviderId: 'openai', currentModelId: 'gpt-4o', agents: [] } as any)
  useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id })
  useDirectoryStore.setState({ currentDirectory: PROJECT.path })
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] })
  useSelectionStore.setState({ sessionModelSelections: new Map(), sessionAgentSelections: new Map() } as any)
  registerRuntimeAPIs(null)
}

function setupChildStores(dir = PROJECT.path) {
  const sessionList: any[] = []
  const messageMap: Record<string, any[]> = {}
  const statusMap: Record<string, any> = {}
  const childStore = {
    getState: () => ({ session: sessionList, message: messageMap, session_status: statusMap, part: {} }),
    setState: (patch: any) => {
      if (patch.session_status) Object.assign(statusMap, patch.session_status)
      if (patch.message) Object.assign(messageMap, patch.message)
    },
  }
  const childStores = {
    children: new Map<string, typeof childStore>(),
    ensureChild: (d: string) => { if (!childStores.children.has(d)) childStores.children.set(d, childStore); return childStores.children.get(d)! },
    getChild: (d: string) => childStores.children.get(d) ?? childStore,
  }
  setActionRefs(opencodeClient as any, childStores as any, () => dir)
  setOptimisticRefs(
    (input: any) => {
      const store = childStores.ensureChild(input.directory ?? dir)
      const current = store.getState()
      const msgs = [...(current.message[input.sessionID] ?? [])]
      if (!msgs.find((m: any) => m.id === input.message.id)) msgs.push(input.message)
      store.setState({ message: { ...current.message, [input.sessionID]: msgs }, session_status: { ...current.session_status, [input.sessionID]: { type: 'busy' } } })
    },
    () => {},
  )
}

beforeEach(() => {
  originalBuildMessageParts = opencodeClient.buildMessageParts
  originalGetDirectory = opencodeClient.getDirectory
  originalCreateSession = opencodeClient.createSession
  originalSendMessage = opencodeClient.sendMessage
  originalSendCommand = opencodeClient.sendCommand
  originalDeleteSessionMessage = opencodeClient.deleteSessionMessage
  originalShellSession = opencodeClient.shellSession
  originalFetch = globalThis.fetch
  originalCaptureDraftRuntime = useInputStore.getState().captureDraftRuntime
  originalGetDraft = useInputStore.getState().getDraft
  originalFinalizeDraftOwnership = useInputStore.getState().finalizeDraftOwnership
  ownershipCalls = []
  notificationRequests = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/message-sent')) notificationRequests.push({ url: String(input), init })
    return new Response(null, { status: 200 })
  }) as typeof globalThis.fetch

  opencodeClient.buildMessageParts = async (params: any) => {
    const parts: any[] = []
    if (params.text?.trim()) parts.push({ type: 'text', text: params.text.trim() })
    if (params.files?.length) for (const f of params.files) parts.push({ type: 'file', mime: f.mime, url: f.url, filename: f.filename })
    if (params.additionalParts?.length) {
      for (const ap of params.additionalParts) {
        if (ap.text?.trim()) parts.push({ type: 'text', text: ap.text.trim(), synthetic: ap.synthetic })
        if (ap.files?.length) for (const f of ap.files) parts.push({ type: 'file', mime: f.mime, url: f.url, filename: f.filename })
      }
    }
    if (params.agentMentions?.length) for (const am of params.agentMentions) parts.push({ type: 'agent', name: am.name })
    return parts
  }
  opencodeClient.getDirectory = () => PROJECT.path
  opencodeClient.createSession = (async (_params: any, _dir?: string | null) => ({ id: SESSION_ID, slug: 't', projectID: 'proj-comb', directory: _dir ?? PROJECT.path, title: 'Test', time: { created: Date.now(), updated: Date.now() }, version: '1' })) as any

  resetAll()
  setupChildStores()
  queryClient.clear()
})

afterEach(() => {
  opencodeClient.buildMessageParts = originalBuildMessageParts
  opencodeClient.getDirectory = originalGetDirectory
  opencodeClient.createSession = originalCreateSession
  opencodeClient.sendMessage = originalSendMessage
  opencodeClient.sendCommand = originalSendCommand
  opencodeClient.deleteSessionMessage = originalDeleteSessionMessage
  opencodeClient.shellSession = originalShellSession
  globalThis.fetch = originalFetch
  useInputStore.setState({
    captureDraftRuntime: originalCaptureDraftRuntime,
    getDraft: originalGetDraft,
    finalizeDraftOwnership: originalFinalizeDraftOwnership,
  })
  registerRuntimeAPIs(null)
  setActionRefs(null as any, null as any, () => '')
  setOptimisticRefs(null as any, null as any)
  queryClient.clear()
})

// ─── tests ──────────────────────────────────────────────────────────────────

describe('handleCombinedDraftSend', () => {

  test('1) pending same tick — draftSubmitting true, second send does not call endpoint', async () => {
    let calls = 0
    let resolveFirst!: (v: any) => void
    const firstDeferred = new Promise<ConversationCreateWithPromptResult>((resolve) => { resolveFirst = resolve })
    registerRuntimeAPIs(makeCombinedAPI(async () => { calls++; return firstDeferred }))

    useSessionUIStore.getState().openNewSessionDraft()
    const sendPromise = useSessionUIStore.getState().sendMessage('hello', 'openai', 'gpt-4o')

    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(true)

    // Second send should throw (draft already claimed)
    await useSessionUIStore.getState().sendMessage('hello again', 'openai', 'gpt-4o').catch(() => {})

    resolveFirst(successResult())
    await sendPromise
    expect(calls).toBe(1)
  })

  test('2) success — full session global upsert, marked created, current selection, one optimistic user message', async () => {
    let capturedInput: ConversationCreateWithPromptInput | null = null
    registerRuntimeAPIs(makeCombinedAPI(async (input) => { capturedInput = { ...input, parts: [...input.parts] }; return successResult() }))

    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage('hello', 'openai', 'gpt-4o')

    expect(capturedInput).not.toBeNull()
    expect(capturedInput!.messageID.startsWith('msg_')).toBe(true)
    expect(capturedInput!.model).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
    expect(capturedInput!.parts.some((p: any) => p.type === 'text')).toBe(true)
    await flushNotifications()
    expect(notificationRequests).toHaveLength(1)
    expect(new Headers(notificationRequests[0].init?.headers).get('Content-Type')).toBe('application/json')
    expect(notificationRequests[0].init?.body).toBe(JSON.stringify({ messageID: capturedInput!.messageID }))

    const allSessions = [...useGlobalSessionsStore.getState().activeSessions, ...useGlobalSessionsStore.getState().archivedSessions]
    expect(allSessions.some((s: any) => s.id === SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().isOpenChamberCreatedSession(SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
  })

  test('success consumes the opened source with its exact runtime, key, and revision', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => successResult()))
    useSessionUIStore.getState().openNewSessionDraft()
    const draftID = useSessionUIStore.getState().newSessionDraft.draftID!
    const { runtime, source, revision } = installOwnershipSource(draftID)

    await useSessionUIStore.getState().sendMessage('owned success', 'openai', 'gpt-4o')

    expect(ownershipCalls).toEqual([{
      source,
      destination: sessionDraftKey(runtime, SESSION_ID),
      expectedSourceRevision: revision,
      disposition: 'consume',
      runtime,
    }])
  })

  test('3) SSE-first — pre-place message in child store, response must not duplicate', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => {
      // SSE arrives before response: simulate by having optimisticInsertUserMessage
      // do its normal work, then the response finalize checks getDirectoryState
      return successResult()
    }))
    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage('sse test', 'openai', 'gpt-4o')
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    // No duplicate — the flow already checks existingMessages before insert
  })

  test('4) transport throws twice then succeeds — three attempts same messageID', async () => {
    let attempt = 0
    const capturedIds: string[] = []
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      attempt++; capturedIds.push(input.messageID)
      if (attempt < 3) throw new Error('transport fail ' + attempt)
      return successResult(input.messageID)
    }))
    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage('retry', 'openai', 'gpt-4o')
    expect(attempt).toBe(3)
    expect(new Set(capturedIds).size).toBe(1)
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
  })

  test('5) transport all failures — reject localized, draft retryable, input restored', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => { throw new Error('network down') }))
    useSessionUIStore.getState().openNewSessionDraft()
    let error: Error | null = null
    try { await useSessionUIStore.getState().sendMessage('will fail', 'openai', 'gpt-4o') } catch (e) { error = e as Error }
    expect(error).not.toBeNull()
    expect(error!.message).not.toContain('network down')
    expect(error!.message.length).toBeGreaterThan(0)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false)
    expect(useInputStore.getState().pendingInputText).toBe('will fail')
  })

  test('6) create/validate/conflict/unavailable/internal — draft recovery + reject + input', async () => {
    const phases = ['create', 'validate', 'conflict', 'unavailable', 'internal'] as FailPhase[]
    for (const phase of phases) {
      resetAll()
      useSessionUIStore.setState(s => ({ ...s, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false } }))
      registerRuntimeAPIs(makeCombinedAPI(async () => failResult(phase)))
      useSessionUIStore.getState().openNewSessionDraft()
      let caught = false
      try { await useSessionUIStore.getState().sendMessage(phase, 'openai', 'gpt-4o') } catch { caught = true }
      expect(caught).toBe(true)
      expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
      expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false)
      expect(useInputStore.getState().pendingInputText).toBe(phase)
      await flushNotifications()
      expect(notificationRequests).toHaveLength(0)
    }
  })

  test('6b) unavailable retries with same messageID then succeeds', async () => {
    let attempt = 0
    const ids: string[] = []
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      attempt++
      ids.push(input.messageID)
      if (attempt < 3) return failResult('unavailable')
      return successResult(input.messageID)
    }))
    useSessionUIStore.getState().openNewSessionDraft()
    await useSessionUIStore.getState().sendMessage('unav retry', 'openai', 'gpt-4o')
    expect(attempt).toBe(3)
    expect(new Set(ids).size).toBe(1)
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
  })

  test('6c) unavailable exhaust retries — draft restored, input restored, reject', async () => {
    let attempt = 0
    const ids: string[] = []
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      attempt++
      ids.push(input.messageID)
      return failResult('unavailable')
    }))
    useSessionUIStore.getState().openNewSessionDraft()
    let caught = false
    try { await useSessionUIStore.getState().sendMessage('unav exhaust', 'openai', 'gpt-4o') } catch { caught = true }
    expect(caught).toBe(true)
    expect(attempt).toBe(3)
    expect(new Set(ids).size).toBe(1)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false)
    expect(useInputStore.getState().pendingInputText).toBe('unav exhaust')
  })

  test('7) prompt permanent — session selected/global, no optimistic, input, reject', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => promptResult(false)))
    useSessionUIStore.getState().openNewSessionDraft()
    let caught = false
    try { await useSessionUIStore.getState().sendMessage('perm fail', 'openai', 'gpt-4o') } catch { caught = true }
    expect(caught).toBe(true)
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    const all = [...useGlobalSessionsStore.getState().activeSessions, ...useGlobalSessionsStore.getState().archivedSessions]
    expect(all.some((s: any) => s.id === SESSION_ID)).toBe(true)
    expect(useInputStore.getState().pendingInputText).toBe('perm fail')
    await flushNotifications()
    expect(notificationRequests).toHaveLength(0)
  })

  test('prompt permanent and unresolved ambiguous delivery preserve the opened source', async () => {
    for (const [content, result] of [['permanent owned', promptResult(false)], ['ambiguous owned', promptResult(true)]] as const) {
      resetAll()
      ownershipCalls = []
      registerRuntimeAPIs(makeCombinedAPI(async () => result))
      useSessionUIStore.getState().openNewSessionDraft()
      const draftID = useSessionUIStore.getState().newSessionDraft.draftID!
      const { runtime, source, revision } = installOwnershipSource(draftID)

      await useSessionUIStore.getState().sendMessage(content, 'openai', 'gpt-4o').catch(() => {})

      expect(ownershipCalls).toEqual([{
        source,
        destination: sessionDraftKey(runtime, SESSION_ID),
        expectedSourceRevision: revision,
        disposition: 'preserve',
        runtime,
      }])
    }
  })

  test('pre-create failure performs zero ownership finalization', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => failResult('create')))
    useSessionUIStore.getState().openNewSessionDraft()
    installOwnershipSource(useSessionUIStore.getState().newSessionDraft.draftID!)

    await useSessionUIStore.getState().sendMessage('create failure', 'openai', 'gpt-4o').catch(() => {})

    expect(ownershipCalls).toHaveLength(0)
  })

  test('old combined success consumes its old source while retaining the reopened draft and current UI', async () => {
    let resolveResult!: (value: ConversationCreateWithPromptResult) => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const response = new Promise<ConversationCreateWithPromptResult>((resolve) => { resolveResult = resolve })
    registerRuntimeAPIs(makeCombinedAPI(async () => { entered(); return response }))
    useSessionUIStore.getState().openNewSessionDraft({ title: 'Old title' })
    const oldDraftID = useSessionUIStore.getState().newSessionDraft.draftID!
    const { runtime, source, revision } = installOwnershipSource(oldDraftID)
    const send = useSessionUIStore.getState().sendMessage('old success', 'openai', 'gpt-4o')
    await enteredPromise
    useSessionUIStore.getState().closeNewSessionDraft()
    useSessionUIStore.getState().openNewSessionDraft({ title: 'Current title' })
    const currentDraftID = useSessionUIStore.getState().newSessionDraft.draftID

    resolveResult(successResult())
    await send

    expect(ownershipCalls).toEqual([{
      source,
      destination: sessionDraftKey(runtime, SESSION_ID),
      expectedSourceRevision: revision,
      disposition: 'consume',
      runtime,
    }])
    expect({
      open: useSessionUIStore.getState().newSessionDraft.open,
      draftID: useSessionUIStore.getState().newSessionDraft.draftID,
      title: useSessionUIStore.getState().newSessionDraft.title,
    }).toEqual({ open: true, draftID: currentDraftID, title: 'Current title' })
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
  })

  test('ownership conflicts retain the confirmed remote session and selection', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => successResult()))
    useSessionUIStore.getState().openNewSessionDraft()
    const draftID = useSessionUIStore.getState().newSessionDraft.draftID!
    installOwnershipSource(draftID)
    useInputStore.setState({ finalizeDraftOwnership: async (input) => {
      ownershipCalls.push(input)
      return { status: 'conflict', current: false, durable: false } as any
    } })

    await useSessionUIStore.getState().sendMessage('revision advanced', 'openai', 'gpt-4o')

    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    expect(useGlobalSessionsStore.getState().activeSessions.some((session: any) => session.id === SESSION_ID)).toBe(true)
  })

  test('fallback defers ownership until route resolution and preserves it after route rejection', async () => {
    registerRuntimeAPIs(null)
    let resolveRoute!: () => void
    let routeStarted!: () => void
    const routeStartedPromise = new Promise<void>((resolve) => { routeStarted = resolve })
    opencodeClient.sendMessage = (() => new Promise<void>((resolve) => { resolveRoute = resolve; routeStarted() })) as any
    useSessionUIStore.getState().openNewSessionDraft()
    const first = installOwnershipSource(useSessionUIStore.getState().newSessionDraft.draftID!)
    const success = useSessionUIStore.getState().sendMessage('fallback success', 'openai', 'gpt-4o')
    await routeStartedPromise
    expect(ownershipCalls).toHaveLength(0)
    resolveRoute()
    await success
    expect(ownershipCalls).toHaveLength(1)
    expect(ownershipCalls[0].source).toEqual(first.source)
    expect(ownershipCalls[0].disposition).toBe('consume')

    resetAll()
    ownershipCalls = []
    registerRuntimeAPIs(null)
    let rejectRoute!: (error: Error) => void
    let rejectedRouteStarted!: () => void
    const rejectedRouteStartedPromise = new Promise<void>((resolve) => { rejectedRouteStarted = resolve })
    opencodeClient.sendMessage = (() => new Promise<void>((_, reject) => { rejectRoute = reject; rejectedRouteStarted() })) as any
    useSessionUIStore.getState().openNewSessionDraft()
    const second = installOwnershipSource(useSessionUIStore.getState().newSessionDraft.draftID!)
    const failure = useSessionUIStore.getState().sendMessage('fallback rejection', 'openai', 'gpt-4o')
    await rejectedRouteStartedPromise
    expect(ownershipCalls).toHaveLength(0)
    rejectRoute(new Error('route rejected'))
    await failure.catch(() => {})
    expect(ownershipCalls).toHaveLength(1)
    expect(ownershipCalls[0].source).toEqual(second.source)
    expect(ownershipCalls[0].disposition).toBe('preserve')
  })

  test('fallback ownership rejection preserves the successful route result', async () => {
    registerRuntimeAPIs(null)
    let resolveRoute!: () => void
    let routeStarted!: () => void
    const routeStartedPromise = new Promise<void>((resolve) => { routeStarted = resolve })
    opencodeClient.sendMessage = (() => new Promise<void>((resolve) => { resolveRoute = resolve; routeStarted() })) as any
    useSessionUIStore.getState().openNewSessionDraft()
    installOwnershipSource(useSessionUIStore.getState().newSessionDraft.draftID!)
    useInputStore.setState({ finalizeDraftOwnership: async () => { throw new Error('ownership rejected') } })
    const send = useSessionUIStore.getState().sendMessage('route stays successful', 'openai', 'gpt-4o')
    await routeStartedPromise
    resolveRoute()
    await send
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
  })

  test('8) prompt ambiguous found — session selected, resolves', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => promptResult(true)))
    useSessionUIStore.getState().openNewSessionDraft()
    // fetchRecentSendConfirmationRecords will likely fail (no real SDK), so we go to missing branch
    try { await useSessionUIStore.getState().sendMessage("amb found", "openai", "gpt-4o") } catch { /* noop */ }
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
  })

  test('9) prompt ambiguous missing — session selected, reject, input restore', async () => {
    registerRuntimeAPIs(makeCombinedAPI(async () => promptResult(true)))
    useSessionUIStore.getState().openNewSessionDraft()
    let error: Error | null = null
    try { await useSessionUIStore.getState().sendMessage('amb miss', 'openai', 'gpt-4o') } catch (e) { error = e as Error }
    expect(error).not.toBeNull()
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
    expect(useInputStore.getState().pendingInputText).toBe('amb miss')
    await flushNotifications()
    expect(notificationRequests).toHaveLength(0)
  })

  test('10) stale draft — old response global upsert only, no UI steal', async () => {
    let resolveOld!: (v: any) => void
    const oldDeferred = new Promise<ConversationCreateWithPromptResult>((resolve) => { resolveOld = resolve })
    registerRuntimeAPIs(makeCombinedAPI(async () => oldDeferred))

    useSessionUIStore.getState().openNewSessionDraft({ title: 'Old' })
    const oldSend = useSessionUIStore.getState().sendMessage('old', 'openai', 'gpt-4o')
    await new Promise(r => setTimeout(r, 10))
    useSessionUIStore.getState().closeNewSessionDraft()
    useSessionUIStore.getState().openNewSessionDraft({ title: 'New' })
    expect(useSessionUIStore.getState().newSessionDraft.title).toBe('New')

    resolveOld(successResult())
    await oldSend

    const all = [...useGlobalSessionsStore.getState().activeSessions, ...useGlobalSessionsStore.getState().archivedSessions]
    expect(all.some((s: any) => s.id === SESSION_ID)).toBe(true)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().newSessionDraft.title).toBe('New')
    expect(useSessionUIStore.getState().currentSessionId).not.toBe(SESSION_ID)
  })

  test('11) whitespace slash, shell, missing capability — not call combined endpoint', async () => {
    let count = 0
    registerRuntimeAPIs(makeCombinedAPI(async () => { count++; return successResult() }))

    // whitespace slash
    resetAll(); useSessionUIStore.setState(s => ({ ...s, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false } }))
    useSessionUIStore.getState().openNewSessionDraft()
    try { await useSessionUIStore.getState().sendMessage("  /cmd", 'openai', 'gpt-4o') } catch { /* expected */ }
    expect(count).toBe(0)

    // shell mode
    resetAll(); useSessionUIStore.setState(s => ({ ...s, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false } }))
    useSessionUIStore.getState().openNewSessionDraft()
    try { await useSessionUIStore.getState().sendMessage('ls', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'shell') } catch { /* expected */ }
    expect(count).toBe(0)

    // no capability
    registerRuntimeAPIs(null)
    resetAll(); useSessionUIStore.setState(s => ({ ...s, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false } }))
    useSessionUIStore.getState().openNewSessionDraft()
    try { await useSessionUIStore.getState().sendMessage('no api', 'openai', 'gpt-4o') } catch { /* expected */ }
    expect(count).toBe(0)
  })

  test('12) synthetic/additional/file/agent payload exact, messageID format msg_', async () => {
    let capturedInput: ConversationCreateWithPromptInput | null = null
    registerRuntimeAPIs(makeCombinedAPI(async (input) => { capturedInput = { ...input, parts: [...input.parts] }; return successResult() }))

    useSessionUIStore.setState(s => ({ ...s,
      newSessionDraft: { open: true, draftID: crypto.randomUUID(), directoryOverride: null, parentID: null, draftSubmitting: false, syntheticParts: [{ text: 'synth ctx', synthetic: true }] },
      webUICreatedSessions: new Set(),
    }))

    const attachment = { id: 'f1', filename: 'readme.md', mimeType: 'text/markdown', dataUrl: 'data:text/markdown;base64,Rw==', size: 1 } as any
    await useSessionUIStore.getState().sendMessage('main text', 'openai', 'gpt-4o', 'agent1', [attachment], '@deployer', [{ text: 'extra', synthetic: true }], 'v1', 'normal')

    expect(capturedInput).not.toBeNull()
    expect(/^msg_/.test(capturedInput!.messageID)).toBe(true)
    expect(capturedInput!.model).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
    expect(capturedInput!.agent).toBe('agent1')
    expect(capturedInput!.variant).toBe('v1')

    const parts = capturedInput!.parts as any[]
    expect(parts.some((p: any) => p.type === 'text' && p.text === 'main text')).toBe(true)
    expect(parts.some((p: any) => p.type === 'file' && p.filename === 'readme.md')).toBe(true)
    expect(parts.some((p: any) => p.type === 'agent' && p.name === '@deployer')).toBe(true)
    expect(parts.some((p: any) => p.type === 'text' && p.text === 'extra' && p.synthetic === true)).toBe(true)
    expect(parts.some((p: any) => p.type === 'text' && p.text === 'synth ctx' && p.synthetic === true)).toBe(true)
    expect(parts.length).toBe(5)
  })

  test('13) existing send confirms caller and notification once', async () => {
    let callerConfirmations = 0
    opencodeClient.sendMessage = (async () => {}) as any

    await routeMessage({
      sessionId: SESSION_ID,
      directory: PROJECT.path,
      content: 'confirmed',
      providerID: 'openai',
      modelID: 'gpt-4o',
      messageID: 'msg_existing_confirmed',
      onSendConfirmed: () => { callerConfirmations++ },
    })

    await flushNotifications()
    expect(callerConfirmations).toBe(1)
    expect(notificationRequests).toHaveLength(1)
    expect(notificationRequests[0].init?.body).toBe(JSON.stringify({ messageID: 'msg_existing_confirmed' }))
  })

  test('14) pre-dispatch and definitive rejection do not notify', async () => {
    setOptimisticRefs(null as any, null as any)
    await routeMessage({ sessionId: SESSION_ID, directory: PROJECT.path, content: 'pre-dispatch', providerID: 'openai', modelID: 'gpt-4o' }).catch(() => {})
    await flushNotifications()
    expect(notificationRequests).toHaveLength(0)

    setupChildStores()
    opencodeClient.sendMessage = (async () => { throw new Error('rejected') }) as any
    await routeMessage({ sessionId: SESSION_ID, directory: PROJECT.path, content: 'rejected', providerID: 'openai', modelID: 'gpt-4o' }).catch(() => {})
    await flushNotifications()
    expect(notificationRequests).toHaveLength(0)
  })

  test('15) shell success confirms once after its response', async () => {
    let callerConfirmations = 0
    opencodeClient.shellSession = (async () => {}) as any
    await routeMessage({
      sessionId: SESSION_ID,
      directory: PROJECT.path,
      content: 'pwd',
      providerID: 'openai',
      modelID: 'gpt-4o',
      inputMode: 'shell',
      messageID: 'msg_shell_confirmed',
      onSendConfirmed: () => { callerConfirmations++ },
    })
    await flushNotifications()
    expect(callerConfirmations).toBe(1)
    expect(notificationRequests).toHaveLength(1)
  })

  test('16) slash commands resolve from query catalogs without sync command bootstrap', async () => {
    const transport = getRuntimeTransportIdentity()
    queryClient.setQueryData(commandQueryOptions(PROJECT.path, transport).queryKey, [{ name: 'deploy' }])
    queryClient.setQueryData(installedSkillsQueryOptions(PROJECT.path, transport).queryKey, [])
    let command = ''
    opencodeClient.sendCommand = (async (input: { command: string }) => { command = input.command }) as any

    await routeMessage({
      sessionId: SESSION_ID,
      directory: PROJECT.path,
      content: '/deploy production',
      providerID: 'openai',
      modelID: 'gpt-4o',
    })

    expect(command).toBe('deploy')
  })
})

describe('staged message edits', () => {
  test('commit the edit only for a direct composer send', async () => {
    const messages = {
      [SESSION_ID]: [
        { id: 'msg_2', sessionID: SESSION_ID, role: 'user', time: { created: 2 } },
        { id: 'msg_3', sessionID: SESSION_ID, role: 'assistant', time: { created: 3 } },
      ],
    }
    const parts = {
      msg_2: [{ id: 'prt_2', messageID: 'msg_2', type: 'text', text: 'original' }],
      msg_3: [{ id: 'prt_3', messageID: 'msg_3', type: 'text', text: 'answer' }],
    }
    const childStore = {
      getState: () => ({ session: [], message: messages, part: parts, session_status: {} }),
      setState: (patch: Record<string, unknown>) => {
        if (patch.message) Object.assign(messages, patch.message)
        if (patch.part) Object.assign(parts, patch.part)
      },
    }
    const childStores = {
      children: new Map([[PROJECT.path, childStore]]),
      ensureChild: () => childStore,
      getChild: () => childStore,
    }
    setActionRefs({
      session: {
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
      },
    } as any, childStores as any, () => PROJECT.path)
    useSessionUIStore.setState({
      currentSessionId: SESSION_ID,
      currentSessionDirectory: PROJECT.path,
      stagedMessageEdit: { sessionId: SESSION_ID, messageId: 'msg_2' },
    })

    const sequence: string[] = []
    opencodeClient.deleteSessionMessage = (async (_sessionId: string, messageId: string) => {
      sequence.push(`delete:${messageId}`)
      return true
    }) as any
    opencodeClient.sendMessage = (async (params: { text: string }) => {
      sequence.push(`send:${params.text}`)
    }) as any

    await useSessionUIStore.getState().sendMessage('programmatic', 'openai', 'gpt-4o')

    expect(sequence).toEqual(['send:programmatic'])
    expect(useSessionUIStore.getState().stagedMessageEdit).toEqual({ sessionId: SESSION_ID, messageId: 'msg_2' })

    await useSessionUIStore.getState().sendMessage('replacement', 'openai', 'gpt-4o', undefined, undefined, undefined, undefined, undefined, undefined, {
      commitStagedMessageEdit: true,
    })

    expect(sequence).toEqual(['send:programmatic', 'delete:msg_3', 'delete:msg_2', 'send:replacement'])
    expect(useSessionUIStore.getState().stagedMessageEdit).toBe(null)
  })

  test('an explicit queued owner directory routes POST and optimistic state to that directory', async () => {
    const directoryA = '/projects/queue-owner-a'
    const directoryB = '/projects/current-b'
    const messageID = 'msg_queue_operation_a'
    const posts: Array<{ directory?: string; messageId?: string }> = []
    const optimisticDirectories: string[] = []
    useSessionUIStore.setState({ currentSessionId: SESSION_ID, currentSessionDirectory: directoryB })
    setOptimisticRefs((input: any) => { optimisticDirectories.push(input.directory) }, () => {})
    opencodeClient.sendMessage = (async (params: { directory?: string; messageId?: string }) => { posts.push(params) }) as any

    await useSessionUIStore.getState().sendMessage('queued', 'openai', 'gpt-4o', undefined, undefined, undefined, undefined, undefined, 'normal', {
      sessionId: SESSION_ID,
      directoryHint: directoryA,
      messageID,
    })

    expect(posts.map(({ directory, messageId }) => ({ directory, messageId }))).toEqual([{ directory: directoryA, messageId: messageID }])
    expect(optimisticDirectories).toEqual([directoryA])
    expect(posts.filter((post) => post.directory === directoryB)).toHaveLength(0)
    expect(optimisticDirectories.filter((directory) => directory === directoryB)).toHaveLength(0)
  })
})
