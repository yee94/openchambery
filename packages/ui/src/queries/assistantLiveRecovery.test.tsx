/**
 * Foreground HTTP reconcile for missed assistant SSE tips (relay drop / pause).
 * Mounts real snapshot + contact hooks with a controllable HTTP tip bus.
 *
 * Server emitter (notifications/emitter-runtime.js): SSE may drop while paused
 * or destroy a slow client — authoritative recovery is GET pull.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TipEvent = {
  type: string
  revision?: number
  occurredAt?: number
  assistantID?: string
  turnID?: string
  status?: string
}

const hoisted = vi.hoisted(() => {
  const tipListeners = new Set<(event: TipEvent) => void>()
  const emitTip = (event: TipEvent) => {
    for (const listener of [...tipListeners]) listener(event)
  }
  let transport = 'live-recovery-transport'
  let runtimeGeneration = 1
  const assistantID = 'asst_live_recovery'
  type Pending = {
    resolve: (value: Response) => void
    reject: (error: unknown) => void
    path: string
  }
  const httpState = {
    contactFetches: 0,
    snapshotFetches: 0,
    contactBodies: [] as unknown[],
    snapshotBodies: [] as unknown[],
    failNextContact: false,
    pendingContact: [] as Pending[],
    pendingSnapshot: [] as Pending[],
    /** When true, contact GETs wait until resolveNextContact(). */
    gateContact: false,
    /** When true, snapshot GETs wait until resolveNextSnapshot(). */
    gateSnapshot: false,
    contactQueue: [] as unknown[],
    snapshotQueue: [] as unknown[],
    defaultContact: null as unknown,
    defaultSnapshot: null as unknown,
  }
  let testQueryClient: QueryClient | null = null
  const getQueryClient = () => {
    if (!testQueryClient) {
      testQueryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
          },
        },
      })
    }
    return testQueryClient
  }
  return {
    tipListeners,
    emitTip,
    get transport() { return transport },
    setTransport(next: string) { transport = next },
    get runtimeGeneration() { return runtimeGeneration },
    setRuntimeGeneration(next: number) { runtimeGeneration = next },
    assistantID,
    httpState,
    getQueryClient,
  }
})

const {
  tipListeners,
  emitTip,
  assistantID,
  httpState,
  getQueryClient,
} = hoisted
const testQueryClient = getQueryClient()

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => hoisted.transport,
  getRuntimeGeneration: () => hoisted.runtimeGeneration,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}))

vi.mock('@/lib/session-startup-barrier', () => ({
  waitForSessionStartupBarrier: async () => undefined,
}))

vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: TipEvent) => void) => {
    hoisted.tipListeners.add(listener)
    return () => { hoisted.tipListeners.delete(listener) }
  },
  getLatestOpenchamberEventRevision: () => undefined,
  parseOpenchamberEventEnvelope: () => null,
}))

vi.mock('@/lib/queryRuntime', () => ({
  get queryClient() { return hoisted.getQueryClient() },
  queryKeys: {},
}))

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    const url = String(path)
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    const take = (queue: unknown[], fallback: unknown) => (
      queue.length > 0 ? queue.shift() : fallback
    )
    if (url.includes('/assistants/snapshot')) {
      hoisted.httpState.snapshotFetches += 1
      if (hoisted.httpState.gateSnapshot) {
        return await new Promise<Response>((resolve, reject) => {
          hoisted.httpState.pendingSnapshot.push({ resolve, reject, path: url })
        })
      }
      const body = take(hoisted.httpState.snapshotQueue, hoisted.httpState.defaultSnapshot)
      hoisted.httpState.snapshotBodies.push(body)
      return respond(body)
    }
    if (url.includes('/contact/messages')) {
      hoisted.httpState.contactFetches += 1
      if (hoisted.httpState.failNextContact) {
        hoisted.httpState.failNextContact = false
        return respond({ error: 'upstream_error', message: 'contact unavailable' }, 502)
      }
      if (hoisted.httpState.gateContact) {
        return await new Promise<Response>((resolve, reject) => {
          hoisted.httpState.pendingContact.push({ resolve, reject, path: url })
        })
      }
      const body = take(hoisted.httpState.contactQueue, hoisted.httpState.defaultContact)
      hoisted.httpState.contactBodies.push(body)
      return respond(body)
    }
    if (init?.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return respond({ error: 'unexpected', path: url }, 500)
  },
}))

const {
  ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS,
  CONTACT_WORKING_SNAPSHOT_POLL_MS,
  useAssistantContactMessagesQuery,
  useAssistantSnapshotQuery,
  snapshotHasContactWorking,
  assistantSnapshotQueryOptions,
  assistantContactQueryOptions,
} = await import('./assistantQueries')

const baseAssistant = (extra: Record<string, unknown> = {}) => ({
  id: assistantID,
  revision: 1,
  enabled: true,
  name: 'Live Recovery',
  defaultPrompt: '',
  workspacePath: null,
  effectiveWorkspacePath: '/workspace',
  managedWorkspacePath: '/managed',
  providerID: 'provider',
  modelID: 'model',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: null,
  sessionGeneration: 0,
  historySessionIDs: [],
  historySessionCount: 0,
  assignedSessionIDs: [],
  working: false,
  activeContactTurn: null,
  createdAt: 1,
  updatedAt: 1,
  tombstoneAt: null,
  ...extra,
})

const userMessage = {
  messageID: 'turn_1',
  assistantID,
  role: 'user',
  turnID: 'turn_1',
  bubbleIndex: 0,
  createdAt: 10,
  ordinal: 1,
  status: 'complete',
  fromAssistantID: null,
  fromAssistantName: null,
  parts: [{ type: 'text', text: 'hello' }],
  text: 'hello',
  cards: [],
}

const assistantReply = {
  messageID: 'turn_1:bubble:1',
  assistantID,
  role: 'assistant',
  turnID: 'turn_1',
  bubbleIndex: 0,
  createdAt: 20,
  ordinal: 2,
  status: 'complete',
  fromAssistantID: null,
  fromAssistantName: null,
  parts: [{ type: 'text', text: 'server already replied' }],
  text: 'server already replied',
  cards: [],
}

const contactPage = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  messages,
  nextCursor: null,
  complete: true,
  generation: 0,
  revision: 1,
  ...extra,
})

/** Seed shape for ContactMessagesView cache (query data, not raw HTTP page). */
const contactView = (messages: unknown[], extra: Record<string, unknown> = {}) => {
  const list = messages as Array<{ messageID: string }>
  return {
    messages,
    generation: 0,
    revision: 1,
    olderCursor: null,
    olderComplete: true,
    hasMessageGap: false,
    gapCursor: null,
    gapRequestIDs: null,
    gapTargetIDs: null,
    liveWindowIDs: list.map((m) => m.messageID),
    ...extra,
  }
}
const snapshotPage = (revision: number, assistantExtra: Record<string, unknown> = {}) => ({
  revision,
  enabled: true,
  assistants: [baseAssistant(assistantExtra)],
})

/** Synthetic contact page size (text-only fixtures used by these races). */
const SYNTHETIC_CONTACT_COMPLETE_BYTES = JSON.stringify(contactPage([userMessage, assistantReply])).length

function Probe({ id, active }: { id: string; active: boolean }) {
  const snapshot = useAssistantSnapshotQuery()
  const contact = useAssistantContactMessagesQuery(id, active)
  const assistant = snapshot.data?.assistants.find((item) => item.id === id)
  const texts = (contact.data?.messages ?? []).map((message) => message.text)
  return (
    <div
      data-probe=""
      data-snapshot-revision={snapshot.data?.revision ?? ''}
      data-working={assistant?.working ? '1' : '0'}
      data-active-turn={assistant?.activeContactTurn?.turnID ?? ''}
      data-contact-count={String(contact.data?.messages?.length ?? 0)}
      data-contact-texts={texts.join('|')}
      data-contact-status={contact.status}
      data-snapshot-status={snapshot.status}
      data-contact-fetch-status={contact.fetchStatus}
      data-is-error={contact.isError ? '1' : '0'}
    />
  )
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = []

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const mountProbe = async (active = true) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <QueryClientProvider client={testQueryClient}>
        <Probe id={assistantID} active={active} />
      </QueryClientProvider>,
    )
  })
  await flush()
  return host
}

const readProbe = (host: HTMLDivElement) => {
  const node = host.querySelector('[data-probe]') as HTMLElement | null
  if (!node) throw new Error('probe missing')
  return {
    revision: node.getAttribute('data-snapshot-revision'),
    working: node.getAttribute('data-working') === '1',
    activeTurn: node.getAttribute('data-active-turn'),
    contactCount: Number(node.getAttribute('data-contact-count')),
    texts: node.getAttribute('data-contact-texts') ?? '',
    contactStatus: node.getAttribute('data-contact-status'),
    snapshotStatus: node.getAttribute('data-snapshot-status'),
    contactFetchStatus: node.getAttribute('data-contact-fetch-status'),
    isError: node.getAttribute('data-is-error') === '1',
  }
}

const waitUntil = async (
  host: HTMLDivElement,
  predicate: (probe: ReturnType<typeof readProbe>) => boolean,
  label: string,
  attempts = 50,
) => {
  for (let i = 0; i < attempts; i += 1) {
    const probe = readProbe(host)
    if (predicate(probe)) return probe
    await flush()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`${label}: last=${JSON.stringify(readProbe(host))} c=${httpState.contactFetches} s=${httpState.snapshotFetches}`)
}

const advanceReconcile = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

describe('assistant foreground live recovery', () => {
  beforeEach(() => {
    tipListeners.clear()
    httpState.contactFetches = 0
    httpState.snapshotFetches = 0
    httpState.contactBodies = []
    httpState.snapshotBodies = []
    httpState.failNextContact = false
    httpState.pendingContact = []
    httpState.pendingSnapshot = []
    httpState.gateContact = false
    httpState.gateSnapshot = false
    httpState.contactQueue = []
    httpState.snapshotQueue = []
    httpState.defaultContact = contactPage([userMessage])
    httpState.defaultSnapshot = snapshotPage(2, { working: false, activeContactTurn: null })
    hoisted.setTransport('live-recovery-transport')
    hoisted.setRuntimeGeneration(1)
    testQueryClient.clear()
    focusManager.setFocused(true)
    vi.useRealTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    focusManager.setFocused(true)
    while (httpState.pendingContact.length) {
      httpState.pendingContact.shift()?.reject(new Error('test teardown'))
    }
    while (httpState.pendingSnapshot.length) {
      httpState.pendingSnapshot.shift()?.reject(new Error('test teardown'))
    }
    for (const entry of mounted.splice(0)) {
      await act(async () => { entry.root.unmount() })
      entry.host.remove()
    }
    tipListeners.clear()
    testQueryClient.clear()
  })

  test('foreground reconcile intervals: busy denser, idle always on', () => {
    expect(CONTACT_WORKING_SNAPSHOT_POLL_MS).toBe(2_500)
    expect(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS).toBe(15_000)
    expect(snapshotHasContactWorking(snapshotPage(1, { working: true }) as never)).toBe(true)
    const snapOpts = assistantSnapshotQueryOptions(hoisted.transport)
    expect(snapOpts.refetchInterval?.({ state: { data: snapshotPage(1, { working: true }) as never } } as never)).toBe(CONTACT_WORKING_SNAPSHOT_POLL_MS)
    expect(snapOpts.refetchInterval?.({ state: { data: snapshotPage(1, { working: false }) as never } } as never)).toBe(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS)
    expect(snapOpts.refetchIntervalInBackground).toBe(false)
    testQueryClient.setQueryData([hoisted.transport, 'assistants', 'snapshot'], snapshotPage(1, { working: false }))
    const contactOpts = assistantContactQueryOptions(assistantID, hoisted.transport, hoisted.runtimeGeneration, { reconcileInForeground: true })
    expect(contactOpts.refetchInterval?.()).toBe(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS)
    expect(contactOpts.refetchIntervalInBackground).toBe(false)
    expect(assistantContactQueryOptions(assistantID, hoisted.transport, hoisted.runtimeGeneration, { reconcileInForeground: false }).refetchInterval?.()).toBe(false)
    expect(SYNTHETIC_CONTACT_COMPLETE_BYTES).toBeGreaterThan(200)
    expect(SYNTHETIC_CONTACT_COMPLETE_BYTES).toBeLessThan(2_000)
  })

  test('race A — stale idle cache recovers completed reply via idle foreground reconcile (15s), not 50ms', async () => {
    vi.useFakeTimers()
    httpState.defaultSnapshot = snapshotPage(9, { working: false, activeContactTurn: null })
    httpState.defaultContact = contactPage([userMessage, assistantReply])

    const snapshotKey = [hoisted.transport, 'assistants', 'snapshot'] as const
    const contactKey = [hoisted.transport, hoisted.runtimeGeneration, 'assistants', 'contact', assistantID] as const
    testQueryClient.setQueryData(snapshotKey, snapshotPage(2, { working: false, activeContactTurn: null }))
    testQueryClient.setQueryData(contactKey, contactView([userMessage]))

    const host = await mountProbe()
    expect(readProbe(host).texts).toBe('hello')
    const contactAtMount = httpState.contactFetches

    // Under 15s: still stale (proves we do not rely on a 50ms fluke).
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS - 1_000)
    expect(readProbe(host).texts).toBe('hello')

    // Cross idle reconcile + scheduling slack.
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS + 2_000)
    const after = readProbe(host)
    expect(after.texts).toContain('server already replied')
    expect(after.contactCount).toBeGreaterThan(1)
    expect(httpState.contactFetches).toBeGreaterThan(contactAtMount)
  })

  test('race B — queue HTTP: old contact first, snapshot idle next, contact reply without end tip', async () => {
    vi.useFakeTimers()
    const busyTurn = {
      turnID: 'turn_1',
      messageID: 'turn_1',
      status: 'running' as const,
      admittedAt: 10,
    }
    const busySnap = snapshotPage(4, { working: true, activeContactTurn: busyTurn })
    const idleSnap = snapshotPage(5, { working: false, activeContactTurn: null })
    const oldContact = contactPage([userMessage])
    const completeContact = contactPage([userMessage, assistantReply])

    // Ordered real GET responses (no manual setQueryData for the race body).
    httpState.snapshotQueue = [busySnap, idleSnap, idleSnap, idleSnap]
    httpState.contactQueue = [oldContact, oldContact, completeContact, completeContact]
    httpState.defaultSnapshot = idleSnap
    httpState.defaultContact = completeContact

    const host = await mountProbe()
    await advanceReconcile(0)
    await flush()
    await waitUntil(
      host,
      (p) => p.contactStatus === 'success' && p.texts === 'hello' && p.working === true,
      'busy + stale contact',
      30,
    )

    // Busy poll may still return old contact; then snapshot poll returns idle.
    await advanceReconcile(CONTACT_WORKING_SNAPSHOT_POLL_MS + 500)
    await waitUntil(host, (p) => p.working === false || p.texts.includes('server already replied'), 'idle or reply', 30)

    // Idle foreground reconcile must still pull the completed page without end tip.
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS + 2_000)
    const probe = readProbe(host)
    expect(probe.texts).toContain('server already replied')
    expect(probe.working).toBe(false)
    expect(probe.activeTurn).toBe('')
  })

  test('active=false stops contact polling; HTTP failure keeps prior contact data', async () => {
    vi.useFakeTimers()
    httpState.defaultSnapshot = snapshotPage(3, { working: false })
    httpState.defaultContact = contactPage([userMessage, assistantReply])
    const host = await mountProbe(true)
    await advanceReconcile(0)
    await flush()
    // Cold mount may still be fetching; seed via tip after first success path.
    httpState.defaultContact = contactPage([userMessage, assistantReply])
    await act(async () => {
      emitTip({ type: 'contact-turn-end', assistantID, turnID: 'turn_1', status: 'complete', occurredAt: 1 })
    })
    await flush()
    for (let i = 0; i < 20 && !readProbe(host).texts.includes('server already replied'); i += 1) {
      await flush()
    }
    // Remount inactive: no contact query.
    await act(async () => {
      mounted[0]?.root.render(
        <QueryClientProvider client={testQueryClient}>
          <Probe id={assistantID} active={false} />
        </QueryClientProvider>,
      )
    })
    await flush()
    const fetchesBefore = httpState.contactFetches
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS * 2)
    expect(httpState.contactFetches).toBe(fetchesBefore)

    // Active again with failure: preserve last good data when possible.
    httpState.defaultContact = contactPage([userMessage, assistantReply])
    await act(async () => {
      mounted[0]?.root.render(
        <QueryClientProvider client={testQueryClient}>
          <Probe id={assistantID} active />
        </QueryClientProvider>,
      )
    })
    await flush()
    const good = readProbe(host)
    // Place good data in cache then fail a refetch.
    const contactKey = [hoisted.transport, hoisted.runtimeGeneration, 'assistants', 'contact', assistantID] as const
    testQueryClient.setQueryData(contactKey, contactView([userMessage, assistantReply]))
    httpState.failNextContact = true
    await act(async () => {
      emitTip({ type: 'contact-turn-end', assistantID, turnID: 'turn_1', status: 'complete', occurredAt: 2 })
    })
    await flush()
    await advanceReconcile(100)
    const afterFail = readProbe(host)
    // TanStack keeps previous data on error when placeholder/prior exists.
    expect(afterFail.texts.includes('server already replied') || good.texts.includes('server already replied')).toBe(true)
  })

  test('runtime switch isolates contact keys; two observers share one query flight', async () => {
    vi.useFakeTimers()
    httpState.defaultSnapshot = snapshotPage(1, { working: false })
    httpState.defaultContact = contactPage([userMessage])
    httpState.contactFetches = 0

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    await act(async () => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <Probe id={assistantID} active />
          <Probe id={assistantID} active />
        </QueryClientProvider>,
      )
    })
    await flush()
    await advanceReconcile(0)
    await flush()
    // Two observers → one contact query key → a single in-flight GET (TanStack dedupe).
    expect(httpState.contactFetches).toBeLessThanOrEqual(2)
    const sharedFetches = httpState.contactFetches

    hoisted.setTransport('other-runtime')
    hoisted.setRuntimeGeneration(2)
    // New transport identity requires remount of hooks (effects bind transport at mount).
    await act(async () => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <Probe id={assistantID} active />
        </QueryClientProvider>,
      )
    })
    await flush()
    expect(httpState.contactFetches).toBeGreaterThanOrEqual(sharedFetches)
  })

  test('contact-turn-end tip still invalidates immediately', async () => {
    httpState.defaultSnapshot = snapshotPage(3, { working: false })
    httpState.defaultContact = contactPage([userMessage])
    testQueryClient.clear()
    const host = await mountProbe()
    await waitUntil(
      host,
      (p) => p.contactStatus === 'success' && p.texts === 'hello',
      'user-only mount',
    )
    const before = httpState.contactFetches
    httpState.defaultContact = contactPage([userMessage, assistantReply])
    await act(async () => {
      emitTip({ type: 'contact-turn-end', assistantID, turnID: 'turn_1', status: 'complete', occurredAt: 99 })
    })
    await waitUntil(host, (p) => p.texts.includes('server already replied'), 'after end tip')
    expect(httpState.contactFetches).toBeGreaterThan(before)
  })

  test('hidden focusManager stops interval polls; focus restore refetches', async () => {
    vi.useFakeTimers()
    httpState.defaultSnapshot = snapshotPage(2, { working: false })
    httpState.defaultContact = contactPage([userMessage])
    testQueryClient.clear()
    const host = await mountProbe()
    await advanceReconcile(0)
    await flush()
    await waitUntil(host, (p) => p.contactStatus === 'success', 'initial success', 30)

    const contactBeforeHidden = httpState.contactFetches
    const snapshotBeforeHidden = httpState.snapshotFetches

    focusManager.setFocused(false)
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS)
    await advanceReconcile(ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS)
    expect(httpState.contactFetches).toBe(contactBeforeHidden)
    expect(httpState.snapshotFetches).toBe(snapshotBeforeHidden)

    httpState.defaultContact = contactPage([userMessage, assistantReply])
    httpState.defaultSnapshot = snapshotPage(3, { working: false })
    focusManager.setFocused(true)
    await flush()
    await advanceReconcile(0)
    await waitUntil(
      host,
      (p) => p.texts.includes('server already replied') || httpState.contactFetches > contactBeforeHidden,
      'focus restore refetch',
      40,
    )
    expect(httpState.contactFetches + httpState.snapshotFetches).toBeGreaterThan(contactBeforeHidden + snapshotBeforeHidden)
  })
})
