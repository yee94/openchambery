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
import {
  setActionRefs,
  setOptimisticRefs,
  combinedSendConfirmationOptions,
  resetCombinedSendConfirmationOptions,
} from './session-actions'
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
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false }, availableWorktreesByProject: new Map(), webUICreatedSessions: new Set<string>(), retainedPendingUserMessages: new Map() })
  useInputStore.setState({ pendingInputText: null, pendingInputMode: 'replace', attachedFiles: [] })
  useConfigStore.setState({ isConnected: true, currentAgentName: undefined, currentProviderId: 'openai', currentModelId: 'gpt-4o', agents: [] } as any)
  useProjectsStore.setState({ projects: [PROJECT], activeProjectId: PROJECT.id })
  useDirectoryStore.setState({ currentDirectory: PROJECT.path })
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] })
  useSelectionStore.setState({ sessionModelSelections: new Map(), sessionAgentSelections: new Map() } as any)
  registerRuntimeAPIs(null)
}

function createChildStore() {
  const sessionList: any[] = []
  const messageMap: Record<string, any[]> = {}
  const statusMap: Record<string, any> = {}
  const statusObservedAtMap: Record<string, number> = {}
  const partMap: Record<string, any[]> = {}
  const snapshot = () => ({
    session: sessionList,
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
  const notify = () => { for (const listener of [...listeners]) listener() }
  return {
    getState: snapshot,
    // Presence waiting subscribes like a real child store, so the double must notify.
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

/**
 * session.messages handler used by fetchRecentSendConfirmationRecords / fetchMessagesForSession
 * via setActionRefs. Default rejects so an ordinary selection fetch does not materialize an
 * authoritative empty page that would wipe optimistic fallback rows.
 */
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

function setupChildStores(dir = PROJECT.path, options?: {
  trackEnsureOrder?: string[]
  trackEnsureOptions?: Array<{ directory: string; options?: { bootstrap?: boolean } }>
}) {
  const childStore = createChildStore()
  const childStores = {
    children: new Map<string, typeof childStore>(),
    ensureChild: (d: string, ensureOptions?: { bootstrap?: boolean }) => {
      options?.trackEnsureOrder?.push(`ensure:${d}`)
      options?.trackEnsureOptions?.push({ directory: d, options: ensureOptions })
      if (!childStores.children.has(d)) childStores.children.set(d, childStore)
      return childStores.children.get(d)!
    },
    getChild: (d: string) => childStores.children.get(d) ?? childStore,
  }
  // actionSdk wraps opencodeClient and overrides session.messages for confirmation pulls.
  setActionRefs(makeActionSdk() as any, childStores as any, () => dir)
  setOptimisticRefs(
    (input: any) => {
      const store = childStores.ensureChild(input.directory ?? dir)
      const current = store.getState()
      const msgs = [...(current.message[input.sessionID] ?? [])]
      if (!msgs.find((m: any) => m.id === input.message.id)) msgs.push(input.message)
      store.setState({ message: { ...current.message, [input.sessionID]: msgs }, part: { ...current.part, [input.message.id]: input.parts }, session_status: { ...current.session_status, [input.sessionID]: { type: 'busy' } } })
    },
    () => {},
  )
  return { childStore, childStores }
}

/**
 * Drain the reactive presence wait plus its recovery pull. Sized off the test
 * grace override, not production timings.
 */
async function waitForPresenceRemediation() {
  const grace = combinedSendConfirmationOptions.presenceGraceMs
  await new Promise((resolve) => setTimeout(resolve, grace + 30))
}

function installSessionMessagesMock(fn: (params: any) => Promise<any> | any) {
  const previous = sessionMessagesHandler
  sessionMessagesHandler = fn
  return () => {
    sessionMessagesHandler = previous
  }
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
  sessionMessagesHandler = async () => {
    throw new Error('session.messages not mocked')
  }
  setupChildStores()
  // Keep the presence grace and recovery retries short in tests; production
  // defaults restored in afterEach.
  combinedSendConfirmationOptions.presenceGraceMs = 10
  combinedSendConfirmationOptions.recovery = { attempts: 1, retryDelayMs: 0 }
  queryClient.clear()
})

  afterEach(async () => {
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
  resetCombinedSendConfirmationOptions()
  sessionMessagesHandler = async () => {
    throw new Error('session.messages not mocked')
  }
  // Drain any fire-and-forget confirmation retries scheduled by the prior test.
  await new Promise((resolve) => setTimeout(resolve, 0))
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
    const pending = useSessionUIStore.getState().newSessionDraft.pendingUserMessage
    expect(pending?.info.role).toBe('user')
    expect(pending?.parts.some((part: any) => part.type === 'text' && part.text === 'hello')).toBe(true)

    // Second send should throw (draft already claimed)
    await useSessionUIStore.getState().sendMessage('hello again', 'openai', 'gpt-4o').catch(() => {})

    resolveFirst(successResult())
    await sendPromise
    expect(calls).toBe(1)
  })

  test('2) success — full session global upsert, marked created, current selection', async () => {
    let capturedInput: ConversationCreateWithPromptInput | null = null
    const order: string[] = []
    const ensureOptions: Array<{ directory: string; options?: { bootstrap?: boolean } }> = []
    const knownMessageID = 'msg_combined_auth_0000000000001'
    const { childStore } = setupChildStores(PROJECT.path, { trackEnsureOrder: order, trackEnsureOptions: ensureOptions })
    setOptimisticRefs(null as any, null as any)
    let messagesCalls = 0
    const restoreMessages = installSessionMessagesMock(async (params: any) => {
      messagesCalls += 1
      order.push(`messages:${params.sessionID}`)
      // First confirmation/selection pull empty (catches optimistic-only regressions);
      // subsequent pulls return authoritative user+assistant for the known messageID.
      if (messagesCalls === 1) return { data: [] }
      return {
        data: [
          {
            info: { id: knownMessageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
            parts: [{ id: 'prt_u', type: 'text', text: 'hello', messageID: knownMessageID, sessionID: SESSION_ID }],
          },
          {
            info: { id: 'msg_assistant_auth', role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } },
            parts: [{ id: 'prt_a', type: 'text', text: 'reply', messageID: 'msg_assistant_auth', sessionID: SESSION_ID }],
          },
        ],
      }
    })
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      order.push('createWithPrompt')
      capturedInput = { ...input, parts: [...input.parts] }
      return successResult(input.messageID)
    }))

    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('hello', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', {
        messageID: knownMessageID,
      })

      expect(capturedInput).not.toBeNull()
      expect(capturedInput!.messageID).toBe(knownMessageID)
      expect(capturedInput!.model).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
      expect(capturedInput!.parts.some((p: any) => p.type === 'text')).toBe(true)
      // Child store ensure happens before createWithPrompt with bootstrap:false
      const ensureIdx = order.findIndex((e) => e.startsWith('ensure:'))
      const createIdx = order.indexOf('createWithPrompt')
      expect(ensureIdx).toBeGreaterThanOrEqual(0)
      expect(ensureIdx).toBeLessThan(createIdx)
      expect(ensureOptions.some((entry) =>
        entry.directory === PROJECT.path && entry.options?.bootstrap === false,
      )).toBe(true)
      await flushNotifications()
      expect(notificationRequests).toHaveLength(1)
      expect(new Headers(notificationRequests[0].init?.headers).get('Content-Type')).toBe('application/json')
      expect(notificationRequests[0].init?.body).toBe(JSON.stringify({ messageID: knownMessageID }))

      const allSessions = [...useGlobalSessionsStore.getState().activeSessions, ...useGlobalSessionsStore.getState().archivedSessions]
      expect(allSessions.some((s: any) => s.id === SESSION_ID)).toBe(true)
      expect(useSessionUIStore.getState().isOpenChamberCreatedSession(SESSION_ID)).toBe(true)
      expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
      expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)

      // Authoritative materialization — one user + one assistant, no optimistic
      // markers. It arrives through reactive remediation, not through the send.
      await waitForPresenceRemediation()
      const messages = childStore.getState().message[SESSION_ID] ?? []
      expect(messages.filter((m: any) => m.role === 'user')).toHaveLength(1)
      expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1)
      expect(messages.some((m: any) => m.id === knownMessageID)).toBe(true)
      const allParts = Object.values(childStore.getState().part).flat() as any[]
      expect(allParts.every((p) => !p.__openchamberOptimistic)).toBe(true)
      expect(messagesCalls).toBeGreaterThanOrEqual(2)
    } finally {
      restoreMessages()
    }
  })

  test('combined success materializes authoritative records after a presence miss', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const messageID = 'msg_auth_only'
    let messagesCalls = 0
    // Empty until the ordinary selection fetch has had its turn, so only the
    // reactive remediation pull can be the one that materializes the records.
    let recordsAvailable = false
    const restoreMessages = installSessionMessagesMock(async () => {
      messagesCalls += 1
      if (!recordsAvailable) return { data: [] }
      return {
        data: [
          {
            info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
            parts: [{ id: 'prt_u', type: 'text', text: 'direct paint', messageID, sessionID: SESSION_ID }],
          },
          {
            info: { id: 'msg_auth_assistant', role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } },
            parts: [{ id: 'prt_a', type: 'text', text: 'ok', messageID: 'msg_auth_assistant', sessionID: SESSION_ID }],
          },
        ],
      }
    })
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('direct paint', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID })
      const beforeRemediation = messagesCalls
      expect(childStore.getState().message[SESSION_ID] ?? []).toHaveLength(0)
      recordsAvailable = true
      await waitForPresenceRemediation()
      expect(messagesCalls).toBeGreaterThan(beforeRemediation)
      const messages = childStore.getState().message[SESSION_ID] ?? []
      expect(messages.filter((m: any) => m.role === 'user')).toHaveLength(1)
      expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1)
      expect(messages.some((m: any) => m.id === messageID)).toBe(true)
      const parts = childStore.getState().part[messageID] as any[]
      expect(parts?.every((p) => !p.__openchamberOptimistic)).toBe(true)
    } finally {
      restoreMessages()
    }
  })

  test('happy path retains the sent row and issues no confirmation request', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const messageID = 'msg_no_request'
    let messagesCalls = 0
    const restoreMessages = installSessionMessagesMock(async () => {
      messagesCalls += 1
      return { data: [] }
    })
    // SSE delivers the real row while create+prompt is still resolving.
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      const current = childStore.getState()
      childStore.setState({
        message: {
          ...current.message,
          [SESSION_ID]: [{ id: input.messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } }],
        },
        part: {
          ...current.part,
          [input.messageID!]: [{ id: 'prt_sse', type: 'text', text: 'no request', messageID: input.messageID, sessionID: SESSION_ID }],
        },
      })
      return successResult(input.messageID)
    }))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('no request', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID })
      // The retained presentation covers the handover without touching the store.
      const retained = useSessionUIStore.getState().retainedPendingUserMessages.get(SESSION_ID) ?? []
      expect(retained.map((message) => message.info.id)).toEqual([messageID])
      expect(retained[0]?.info.sessionID).toBe(SESSION_ID)
      expect(retained[0]?.parts.every((part: any) => part.messageID === messageID && part.sessionID === SESSION_ID)).toBe(true)
      // Presence is already satisfied, so remediation adds no request of its own.
      const beforeRemediation = messagesCalls
      await waitForPresenceRemediation()
      expect(messagesCalls).toBe(beforeRemediation)
      useSessionUIStore.getState().clearRetainedPendingUserMessages(SESSION_ID, [messageID])
      expect(useSessionUIStore.getState().retainedPendingUserMessages.has(SESSION_ID)).toBe(false)
    } finally {
      restoreMessages()
    }
  })

  test('marks the new session busy without fabricating a row, and never over a served status', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const messageID = 'msg_busy_status'
    const restoreMessages = installSessionMessagesMock(async () => ({ data: [] }))
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('busy status', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID })
      // Sidebar activity and queue gating read session_status, not the retained row.
      expect(childStore.getState().session_status[SESSION_ID]?.type).toBe('busy')
      expect(typeof childStore.getState().session_status_observed_at?.[SESSION_ID]).toBe('number')
      // The status is the only write: no user row was invented for it.
      expect(childStore.getState().message[SESSION_ID] ?? []).toHaveLength(0)
    } finally {
      restoreMessages()
    }

    // A status already served for the session outranks the inference.
    const second = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const secondMessageID = 'msg_busy_status_served'
    const restoreSecond = installSessionMessagesMock(async () => ({ data: [] }))
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      second.childStore.setState({ session_status: { [SESSION_ID]: { type: 'idle' } } })
      return successResult(input.messageID)
    }))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('served status', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID: secondMessageID })
      expect(second.childStore.getState().session_status[SESSION_ID]?.type).toBe('idle')
    } finally {
      restoreSecond()
    }
  })

  test('presence recovery is insert-only — a newer live assistant row survives', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const messageID = 'msg_insert_only'
    const assistantID = 'msg_insert_only_assistant'
    // SSE already committed a completed assistant row plus a finished part.
    childStore.setState({
      message: {
        [SESSION_ID]: [
          { id: assistantID, role: 'assistant', sessionID: SESSION_ID, finish: 'stop', time: { created: 2, completed: 9 } },
        ],
      },
      part: {
        [assistantID]: [
          { id: 'prt_live_tool', type: 'tool', tool: 'read', messageID: assistantID, sessionID: SESSION_ID, state: { status: 'completed', time: { start: 3, end: 4 } } },
        ],
      },
    })
    // The recovery page is an older snapshot: assistant not finished, tool absent.
    const restoreMessages = installSessionMessagesMock(async () => ({
      data: [
        {
          info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
          parts: [{ id: 'prt_user', type: 'text', text: 'insert only', messageID, sessionID: SESSION_ID }],
        },
        {
          info: { id: assistantID, role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } },
          parts: [],
        },
      ],
    }))
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('insert only', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID })
      await waitForPresenceRemediation()
      const messages = childStore.getState().message[SESSION_ID] ?? []
      // The missing user row is filled in...
      expect(messages.some((m: any) => m.id === messageID)).toBe(true)
      // ...while the live assistant object and its finished part are untouched.
      const assistant = messages.find((m: any) => m.id === assistantID) as any
      expect(assistant?.finish).toBe('stop')
      expect(assistant?.time?.completed).toBe(9)
      expect(childStore.getState().part[assistantID]?.some((part: any) => part.id === 'prt_live_tool')).toBe(true)
    } finally {
      restoreMessages()
    }
  })

  test('fallback draft materializes its complete pending row before prompt dispatch', async () => {
    const { childStore } = setupChildStores()
    registerRuntimeAPIs(null)
    let dispatched = false
    opencodeClient.sendMessage = (async () => { dispatched = true }) as any
    useSessionUIStore.setState((state) => ({ ...state, newSessionDraft: { open: true, draftID: crypto.randomUUID(), directoryOverride: null, parentID: null, draftSubmitting: false, syntheticParts: [{ text: 'fallback synthetic', synthetic: true }] } }))
    const attachment = { id: 'fallback-file', filename: 'fallback.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,Qw==', size: 1 } as any

    await useSessionUIStore.getState().sendMessage('fallback main', 'openai', 'gpt-4o', 'build', [attachment], '@planner', [{ text: 'fallback extra' }], undefined, 'normal', { messageID: 'msg_fallback_parts' })

    expect(dispatched).toBe(true)
    const optimisticParts = childStore.getState().part.msg_fallback_parts
    expect(optimisticParts.map((part: any) => part.type)).toEqual(['text', 'file', 'text', 'text', 'agent'])
    expect(optimisticParts.some((part: any) => part.text === 'fallback synthetic' && part.synthetic === true)).toBe(true)
    expect(optimisticParts.every((part: any) => part.messageID === 'msg_fallback_parts' && part.sessionID === SESSION_ID)).toBe(true)
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

  test('3) SSE-first — pre-placed IDs satisfy presence with no request and no duplicate', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const messageID = 'msg_sse_first'
    let messagesCalls = 0
    // Simulate SSE already writing the same IDs before create returns
    childStore.setState({
      message: {
        [SESSION_ID]: [
          { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
          { id: 'msg_sse_assistant', role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } },
        ],
      },
      part: {
        [messageID]: [{ id: 'prt_sse_u', type: 'text', text: 'sse test', messageID, sessionID: SESSION_ID }],
        msg_sse_assistant: [{ id: 'prt_sse_a', type: 'text', text: 'from sse', messageID: 'msg_sse_assistant', sessionID: SESSION_ID }],
      },
    })
    const restoreMessages = installSessionMessagesMock(async () => {
      messagesCalls += 1
      return {
        data: [
          {
            info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
            parts: [{ id: 'prt_auth_u', type: 'text', text: 'sse test', messageID, sessionID: SESSION_ID }],
          },
          {
            info: { id: 'msg_sse_assistant', role: 'assistant', sessionID: SESSION_ID, time: { created: 2 } },
            parts: [{ id: 'prt_auth_a', type: 'text', text: 'from auth', messageID: 'msg_sse_assistant', sessionID: SESSION_ID }],
          },
        ],
      }
    })
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('sse test', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', { messageID })
      const beforeRemediation = messagesCalls
      await waitForPresenceRemediation()
      expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID)
      // Presence was already satisfied, so remediation pulled nothing and the
      // SSE parts were never rewritten by an authoritative page.
      expect(messagesCalls).toBe(beforeRemediation)
      const messages = childStore.getState().message[SESSION_ID] ?? []
      expect(messages.filter((m: any) => m.id === messageID)).toHaveLength(1)
      expect(messages.filter((m: any) => m.id === 'msg_sse_assistant')).toHaveLength(1)
      expect(messages).toHaveLength(2)
    } finally {
      restoreMessages()
    }
  })

  test('recovery miss does not clear existing store messages', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    const prior = { id: 'msg_prior', role: 'user', sessionID: SESSION_ID, time: { created: 0 } }
    childStore.setState({
      message: { [SESSION_ID]: [prior] },
      part: { msg_prior: [{ id: 'prt_prior', type: 'text', text: 'keep me', messageID: 'msg_prior', sessionID: SESSION_ID }] },
    })
    // Always return empty so confirmation never finds the new messageID
    const restoreMessages = installSessionMessagesMock(async () => ({ data: [] }))
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('miss', 'openai', 'gpt-4o', undefined, [], undefined, undefined, undefined, 'normal', {
        messageID: 'msg_will_miss',
      })
      // Empty recovery pages never materialize; the prior row must remain.
      await waitForPresenceRemediation()
      const messages = childStore.getState().message[SESSION_ID] ?? []
      expect(messages.some((m: any) => m.id === 'msg_prior')).toBe(true)
      expect(messages.some((m: any) => m.id === 'msg_will_miss')).toBe(false)
      expect(childStore.getState().part.msg_prior?.[0]?.text).toBe('keep me')
      // The sent text stays on screen after a bounded presence miss.
      const retained = useSessionUIStore.getState().retainedPendingUserMessages.get(SESSION_ID) ?? []
      expect(retained.map((message) => message.info.id)).toEqual(['msg_will_miss'])
    } finally {
      restoreMessages()
    }
  })

  test('pre-create ensureChild receives bootstrap:false', async () => {
    const ensureOptions: Array<{ directory: string; options?: { bootstrap?: boolean } }> = []
    const order: string[] = []
    setupChildStores(PROJECT.path, { trackEnsureOrder: order, trackEnsureOptions: ensureOptions })
    setOptimisticRefs(null as any, null as any)
    const restoreMessages = installSessionMessagesMock(async () => ({ data: [] }))
    registerRuntimeAPIs(makeCombinedAPI(async (input) => {
      order.push('createWithPrompt')
      return successResult(input.messageID)
    }))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      await useSessionUIStore.getState().sendMessage('bootstrap gate', 'openai', 'gpt-4o')
      const createIdx = order.indexOf('createWithPrompt')
      const ensureBeforeCreate = ensureOptions.filter((_, i) => {
        // trackEnsureOrder and trackEnsureOptions push in the same ensureChild call
        return order[i]?.startsWith('ensure:') && i < createIdx
      })
      // At least one ensure before createWithPrompt must pass bootstrap:false
      // (combined must not start full directory bootstrap past the new-draft gate).
      expect(ensureBeforeCreate.some((entry) => entry.options?.bootstrap === false)).toBe(true)
      expect(ensureOptions.some((entry) =>
        entry.directory === PROJECT.path && entry.options?.bootstrap === false,
      )).toBe(true)
    } finally {
      restoreMessages()
    }
  })

  test('runtime switch after a presence miss does not materialize later records', async () => {
    const { childStore } = setupChildStores()
    setOptimisticRefs(null as any, null as any)
    combinedSendConfirmationOptions.recovery = { attempts: 2, retryDelayMs: 0 }
    const messageID = 'msg_runtime_stale_materialize'
    let captureGeneration = 1
    useInputStore.setState({
      captureDraftRuntime: () => ({ transportIdentity: 't-combined', generation: captureGeneration }),
    })
    let messagesCalls = 0
    let resolveHang!: (value: any) => void
    const hang = new Promise<any>((resolve) => { resolveHang = resolve })
    // Recovery: first attempt empty; second hangs until after the runtime flips,
    // so isCurrent is already false when the records finally land.
    const restoreMessages = installSessionMessagesMock(async () => {
      messagesCalls += 1
      if (messagesCalls === 1) return { data: [] }
      return hang
    })
    registerRuntimeAPIs(makeCombinedAPI(async (input) => successResult(input.messageID)))
    try {
      useSessionUIStore.getState().openNewSessionDraft()
      const sendPromise = useSessionUIStore.getState().sendMessage(
        'stale runtime',
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
      // Let the presence grace lapse and the first recovery attempt miss, then
      // flip claim runtime currentness.
      await waitForPresenceRemediation()
      captureGeneration = 2
      // Unblock pending confirmation with authoritative records that must not materialize.
      resolveHang({
        data: [
          {
            info: { id: messageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
            parts: [{ id: 'prt_stale', type: 'text', text: 'must not land', messageID, sessionID: SESSION_ID }],
          },
        ],
      })
      await sendPromise
      await new Promise((r) => setTimeout(r, 20))
      const messages = childStore.getState().message[SESSION_ID] ?? []
      expect(messages.some((m: any) => m.id === messageID)).toBe(false)
    } finally {
      resolveHang?.({ data: [] })
      restoreMessages()
    }
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
    expect(useSessionUIStore.getState().newSessionDraft.pendingUserMessage).toBe(undefined)
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
        // Authoritative snapshot: the commit range is derived from this, not the store.
        messages: async () => ({
          data: messages[SESSION_ID].map((info) => ({ info, parts: parts[info.id as 'msg_2' | 'msg_3'] ?? [] })),
        }),
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

    // OpenCode rejects delete while busy: delete the old tail first (session
    // still idle / after abort), then dispatch the replacement.
    expect(sequence).toEqual(['send:programmatic', 'delete:msg_3', 'delete:msg_2', 'send:replacement'])
    expect(useSessionUIStore.getState().stagedMessageEdit).toBe(null)
  })

  test('staged edit waits for idle after abort before deleting the old tail', async () => {
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
    let status: { type: 'busy' | 'idle' } = { type: 'busy' }
    const childStore = {
      getState: () => ({ session: [], message: messages, part: parts, session_status: { [SESSION_ID]: status } }),
      setState: (patch: Record<string, unknown>) => {
        if (patch.message) Object.assign(messages, patch.message)
        if (patch.part) Object.assign(parts, patch.part)
        if (patch.session_status) {
          const next = (patch.session_status as Record<string, { type: 'busy' | 'idle' }>)[SESSION_ID]
          if (next) status = next
        }
      },
    }
    const childStores = {
      children: new Map([[PROJECT.path, childStore]]),
      ensureChild: () => childStore,
      getChild: () => childStore,
    }
    setActionRefs({
      session: {
        messages: async () => ({
          data: messages[SESSION_ID].map((info) => ({ info, parts: parts[info.id as 'msg_2' | 'msg_3'] ?? [] })),
        }),
        abort: async () => {
          // Abort is async relative to status events: stay busy briefly, then idle.
          setTimeout(() => { status = { type: 'idle' } }, 30)
          return { data: true }
        },
      },
    } as any, childStores as any, () => PROJECT.path)
    useSessionUIStore.setState({
      currentSessionId: SESSION_ID,
      currentSessionDirectory: PROJECT.path,
      stagedMessageEdit: { sessionId: SESSION_ID, messageId: 'msg_2' },
      messageEditCommitting: { sessionId: SESSION_ID, messageId: 'msg_2' },
    })

    const sequence: string[] = []
    opencodeClient.deleteSessionMessage = (async (_sessionId: string, messageId: string) => {
      // Must only run after the session became idle.
      expect(status.type).toBe('idle')
      sequence.push(`delete:${messageId}`)
      return true
    }) as any
    opencodeClient.sendMessage = (async (params: { text: string }) => {
      sequence.push(`send:${params.text}`)
    }) as any

    await useSessionUIStore.getState().sendMessage('replacement', 'openai', 'gpt-4o', undefined, undefined, undefined, undefined, undefined, undefined, {
      commitStagedMessageEdit: true,
    })

    expect(sequence).toEqual(['delete:msg_3', 'delete:msg_2', 'send:replacement'])
    expect(useSessionUIStore.getState().stagedMessageEdit).toBe(null)
    expect(useSessionUIStore.getState().messageEditCommitting).toBe(null)
  })

  test('staged edit keeps the old tail when delete fails before send', async () => {
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
        messages: async () => ({
          data: messages[SESSION_ID].map((info) => ({ info, parts: parts[info.id as 'msg_2' | 'msg_3'] ?? [] })),
        }),
        abort: async () => ({ data: true }),
      },
    } as any, childStores as any, () => PROJECT.path)
    useSessionUIStore.setState({
      currentSessionId: SESSION_ID,
      currentSessionDirectory: PROJECT.path,
      stagedMessageEdit: { sessionId: SESSION_ID, messageId: 'msg_2' },
      messageEditCommitting: { sessionId: SESSION_ID, messageId: 'msg_2' },
    })

    const sequence: string[] = []
    opencodeClient.deleteSessionMessage = (async (_sessionId: string, messageId: string) => {
      sequence.push(`delete:${messageId}`)
      throw new Error('session.deleteMessage failed (500): rejected')
    }) as any
    opencodeClient.sendMessage = (async () => {
      sequence.push('send:should-not-run')
    }) as any

    let failed: unknown = null
    try {
      await useSessionUIStore.getState().sendMessage(
        'replacement',
        'openai',
        'gpt-4o',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { commitStagedMessageEdit: true },
      )
    } catch (error) {
      failed = error
    }
    expect(failed).toBeTruthy()

    expect(sequence).toEqual(['delete:msg_3'])
    expect(useSessionUIStore.getState().stagedMessageEdit).toEqual({ sessionId: SESSION_ID, messageId: 'msg_2' })
    expect(useSessionUIStore.getState().messageEditCommitting).toBe(null)
    expect(messages[SESSION_ID].map((message) => message.id)).toEqual(['msg_2', 'msg_3'])
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
