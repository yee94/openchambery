/**
 * Contact latest-window + older pagination + gap-fill against controllable HTTP.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AssistantContactMessage } from './assistantDTO'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => {
  const transport = 'contact-page-transport'
  const runtimeGeneration = 1
  const assistantID = 'asst_page'
  type Handler = (url: string) => Response | Promise<Response>
  let handler: Handler = () => new Response(JSON.stringify({ error: 'unset' }), { status: 500 })
  const fetches: string[] = []
  let testQueryClient: QueryClient | null = null
  const getQueryClient = () => {
    if (!testQueryClient) {
      testQueryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 60_000, refetchOnWindowFocus: false } },
      })
    }
    return testQueryClient
  }
  return {
    transport,
    runtimeGeneration,
    assistantID,
    fetches,
    setHandler(next: Handler) { handler = next },
    getHandler() { return handler },
    getQueryClient,
  }
})

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => hoisted.transport,
  getRuntimeGeneration: () => hoisted.runtimeGeneration,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}))
vi.mock('@/lib/session-startup-barrier', () => ({ waitForSessionStartupBarrier: async () => undefined }))
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: () => () => undefined,
  getLatestOpenchamberEventRevision: () => undefined,
}))
vi.mock('@/lib/queryRuntime', () => ({
  get queryClient() { return hoisted.getQueryClient() },
  queryKeys: {},
}))
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string) => {
    hoisted.fetches.push(String(path))
    return hoisted.getHandler()(String(path))
  },
}))

const {
  useAssistantContactMessagesQuery,
  CONTACT_MESSAGES_PAGE_DEFAULT,
  CONTACT_GAP_FILL_MAX_PAGES,
  resetAssistantContactGapFillStateForTests,
} = await import('./assistantQueries')

const msg = (ordinal: number): AssistantContactMessage => ({
  messageID: `id_${ordinal}`,
  assistantID: hoisted.assistantID,
  role: 'assistant',
  turnID: `id_${ordinal}`,
  bubbleIndex: 0,
  createdAt: ordinal,
  ordinal,
  status: 'complete',
  fromAssistantID: null,
  fromAssistantName: null,
  parts: [{ type: 'text', text: `t${ordinal}` }],
  text: `t${ordinal}`,
  cards: [],
})

const envelope = (
  messages: AssistantContactMessage[],
  extra: { nextCursor?: string | null; complete?: boolean; generation?: number; revision?: number } = {},
) => ({
  messages,
  nextCursor: extra.nextCursor === undefined ? null : extra.nextCursor,
  complete: extra.complete ?? (extra.nextCursor == null),
  generation: extra.generation ?? 0,
  revision: extra.revision ?? 1,
})

function Probe({ id, active = true }: { id: string; active?: boolean }) {
  const q = useAssistantContactMessagesQuery(id, active)
  return (
    <div
      data-probe=""
      data-count={String(q.data?.messages.length ?? 0)}
      data-texts={(q.data?.messages ?? []).map((m) => m.text).join(',')}
      data-has-prev={q.hasPreviousPage ? '1' : '0'}
      data-fetching-prev={q.isFetchingPreviousPage ? '1' : '0'}
      data-gap={q.hasMessageGap ? '1' : '0'}
      data-filling-gap={q.isFillingMessageGap ? '1' : '0'}
      data-status={q.status}
      data-gen={String(q.data?.generation ?? '')}
      data-rev={String(q.data?.revision ?? '')}
      ref={(node) => {
        if (node) (node as HTMLElement & { __q?: typeof q }).__q = q
      }}
    />
  )
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = []
const client = hoisted.getQueryClient()

const mount = async (active = true) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe id={hoisted.assistantID} active={active} />
      </QueryClientProvider>,
    )
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return host
}

const probe = (host: HTMLDivElement) => {
  const node = host.querySelector('[data-probe]') as HTMLElement & { __q?: ReturnType<typeof useAssistantContactMessagesQuery> }
  return {
    count: Number(node.getAttribute('data-count')),
    texts: node.getAttribute('data-texts') ?? '',
    hasPrev: node.getAttribute('data-has-prev') === '1',
    gap: node.getAttribute('data-gap') === '1',
    status: node.getAttribute('data-status'),
    gen: node.getAttribute('data-gen'),
    rev: node.getAttribute('data-rev'),
    q: node.__q!,
  }
}

const wait = async (host: HTMLDivElement, pred: (p: ReturnType<typeof probe>) => boolean, label: string) => {
  for (let i = 0; i < 40; i += 1) {
    const p = probe(host)
    if (pred(p)) return p
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  throw new Error(`${label}: ${JSON.stringify(probe(host))} fetches=${hoisted.fetches.length}`)
}

describe('assistant contact pagination query', () => {
  beforeEach(() => {
    hoisted.fetches.length = 0
    client.clear()
    resetAssistantContactGapFillStateForTests()
    hoisted.setHandler(() => new Response(JSON.stringify(envelope([])), { status: 200 }))
  })

  afterEach(async () => {
    for (const entry of mounted.splice(0)) {
      await act(async () => { entry.root.unmount() })
      entry.host.remove()
    }
    client.clear()
  })

  test('latest default page is 20; older pages accumulate; refresh stays one latest GET', async () => {
    const all = Array.from({ length: 45 }, (_, i) => msg(i + 1))
    // newest 20 = 26-45
    const latest = all.slice(25)
    const mid = all.slice(5, 25)
    const oldest = all.slice(0, 5)

    let olderHits = 0
    hoisted.setHandler((url) => {
      const u = new URL(url, 'http://local')
      const before = u.searchParams.get('before')
      const limit = u.searchParams.get('limit')
      expect(limit).toBe(String(CONTACT_MESSAGES_PAGE_DEFAULT))
      if (!before) return new Response(JSON.stringify(envelope(latest, { nextCursor: 'c-mid', complete: false, revision: 1 })), { status: 200 })
      if (before === 'c-mid') {
        olderHits += 1
        return new Response(JSON.stringify(envelope(mid, { nextCursor: 'c-old', complete: false, revision: 1 })), { status: 200 })
      }
      if (before === 'c-old') {
        olderHits += 1
        return new Response(JSON.stringify(envelope(oldest, { nextCursor: null, complete: true, revision: 1 })), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'bad cursor' }), { status: 400 })
    })

    const host = await mount()
    await wait(host, (p) => p.status === 'success' && p.count === 20, 'latest 20')
    const latestFetches = hoisted.fetches.filter((f) => f.includes('/contact/messages') && !f.includes('before=')).length
    expect(latestFetches).toBe(1)

    await act(async () => { await probe(host).q.fetchPreviousPage() })
    await wait(host, (p) => p.count === 40, 'after mid older')
    await act(async () => { await probe(host).q.fetchPreviousPage() })
    await wait(host, (p) => p.count === 45 && !p.hasPrev, 'after oldest')
    expect(olderHits).toBe(2)

    // Concurrent older: second call shares in-flight / no-ops when complete
    await act(async () => {
      await Promise.all([probe(host).q.fetchPreviousPage(), probe(host).q.fetchPreviousPage()])
    })

    const fetchesBeforeRefresh = hoisted.fetches.length
    await act(async () => { await probe(host).q.refetch() })
    await wait(host, (p) => p.count === 45, 'refresh keeps history')
    const latestAfter = hoisted.fetches.slice(fetchesBeforeRefresh).filter((f) => f.includes('/contact/messages') && !f.includes('before=')).length
    expect(latestAfter).toBe(1)
    expect(probe(host).count).toBe(45)
  })

  test('gap fill when more than 20 new messages arrive; failure keeps data and allows retry', async () => {
    const base = Array.from({ length: 20 }, (_, i) => msg(i + 1))
    // After burst: latest window 22-41, missing 21
    const slid = Array.from({ length: 20 }, (_, i) => msg(i + 22))
    let phase: 'initial' | 'slid' | 'gap-fail' | 'gap-ok' = 'initial'
    let gapCalls = 0

    hoisted.setHandler((url) => {
      const u = new URL(url, 'http://local')
      const before = u.searchParams.get('before')
      if (!before) {
        if (phase === 'initial') {
          return new Response(JSON.stringify(envelope(base, { nextCursor: 'c0', complete: false, revision: 1 })), { status: 200 })
        }
        return new Response(JSON.stringify(envelope(slid, { nextCursor: 'gap', complete: false, revision: 2 })), { status: 200 })
      }
      if (before === 'gap') {
        gapCalls += 1
        if (phase === 'gap-fail') {
          return new Response(JSON.stringify({ error: 'upstream_error' }), { status: 502 })
        }
        return new Response(JSON.stringify(envelope([msg(21)], { nextCursor: null, complete: true, revision: 2 })), { status: 200 })
      }
      return new Response(JSON.stringify(envelope([])), { status: 200 })
    })

    const host = await mount()
    await wait(host, (p) => p.count === 20, 'initial')
    phase = 'slid'
    await act(async () => { await probe(host).q.refetch() })
    await wait(host, (p) => p.count >= 40, 'slid merge')
    // auto gap fill may run
    phase = 'gap-ok'
    await act(async () => { await probe(host).q.retryMessageGap() })
    await wait(host, (p) => p.texts.includes('t21') || p.count >= 41, 'gap filled')
    expect(probe(host).count).toBeGreaterThanOrEqual(41)
    expect(probe(host).texts).toContain('t21')

    // failure then retry on same mount
    phase = 'initial'
    await act(async () => { await probe(host).q.refetch() })
    // force a gap again
    phase = 'slid'
    await act(async () => { await probe(host).q.refetch() })
    await wait(host, (p) => p.count >= 40, 'slid again')
    phase = 'gap-fail'
    const beforeFail = probe(host).count
    await act(async () => {
      try { await probe(host).q.retryMessageGap() } catch { /* keep prior rows */ }
    })
    expect(probe(host).count).toBeGreaterThanOrEqual(beforeFail)
    phase = 'gap-ok'
    await act(async () => { await probe(host).q.retryMessageGap() })
    await wait(host, (p) => p.texts.includes('t21'), 'retry ok')
    expect(gapCalls).toBeGreaterThan(0)
    expect(CONTACT_GAP_FILL_MAX_PAGES).toBe(5)
  })

  test('exact messageID admission uses messageID query and not before', async () => {
    const { confirmContactAdmissionByMessageID } = await import('./assistantQueries')
    hoisted.fetches.length = 0
    hoisted.setHandler((url) => {
      const u = new URL(url, 'http://local')
      expect(u.searchParams.get('messageID')).toBe('oc_far')
      expect(u.searchParams.get('before')).toBeNull()
      expect(u.searchParams.get('limit')).toBe('1')
      return new Response(JSON.stringify(envelope([{
        ...msg(101),
        messageID: 'oc_far',
        role: 'user',
        turnID: 'oc_far',
        text: 'deep',
        parts: [{ type: 'text', text: 'deep' }],
      }], { revision: 9 })), { status: 200 })
    })
    const result = await confirmContactAdmissionByMessageID(hoisted.assistantID, 'oc_far')
    expect(result).toEqual({ admitted: true, messageID: 'oc_far', revision: 9 })
  })

  test('generation bump on latest page replaces prior history', async () => {
    const { applyContactLatestPage } = await import('./assistantContactMessages')
    const first = applyContactLatestPage(null, envelope([msg(1), msg(2)], { generation: 0, revision: 1 }))
    expect(first.messages).toHaveLength(2)
    const bumped = applyContactLatestPage(first, envelope([msg(9)], { generation: 1, revision: 3 }))
    expect(bumped.generation).toBe(1)
    expect(bumped.messages.map((m) => m.ordinal)).toEqual([9])
  })

  test('multi-batch gap (>=221 missing): same latest mid-fill keeps resume; no re-fetch completed cursors; closes', async () => {
    // Initial 1..20; slide to 242..261 → missing 21..241 (221) needs ≥12 pages; batch cap 5 → multi-batch.
    const initial = Array.from({ length: 20 }, (_, i) => msg(i + 1))
    const live = Array.from({ length: 20 }, (_, i) => msg(i + 242))
    const gapChain: Array<{ cursor: string; next: string | null; start: number }> = []
    for (let start = 222; start >= 2; start -= 20) {
      const idx = gapChain.length
      gapChain.push({
        cursor: `g${idx}`,
        next: start - 20 >= 2 ? `g${idx + 1}` : null,
        start,
      })
    }
    expect(gapChain.length).toBeGreaterThanOrEqual(3)
    const byCursor = new Map(gapChain.map((g) => [g.cursor, g]))
    const beforeHits: string[] = []
    let latestRev = 1
    // Gate every gap page until openGate=false (keeps mid-fill observable).
    const pendingGap: Array<{ cursor: string; resolve: () => void }> = []
    let openGate = false

    hoisted.setHandler((url) => {
      const u = new URL(url, 'http://local')
      const before = u.searchParams.get('before')
      if (!before) {
        if (latestRev === 1) {
          return new Response(JSON.stringify(envelope(initial, {
            nextCursor: 'c0', complete: false, revision: 1,
          })), { status: 200 })
        }
        return new Response(JSON.stringify(envelope(live, {
          nextCursor: 'g0', complete: false, revision: latestRev,
        })), { status: 200 })
      }
      beforeHits.push(before)
      const step = byCursor.get(before)
      if (!step) return new Response(JSON.stringify({ error: 'bad' }), { status: 400 })
      const pageMsgs = Array.from({ length: 20 }, (_, i) => msg(step.start + i)).filter((m) => m.ordinal >= 1)
      const body = envelope(pageMsgs, {
        nextCursor: step.next,
        complete: step.next == null,
        revision: latestRev,
      })
      const response = new Response(JSON.stringify(body), { status: 200 })
      if (!openGate) {
        return new Promise<Response>((resolve) => {
          pendingGap.push({ cursor: before, resolve: () => resolve(response) })
        })
      }
      return response
    })

    const releaseOne = async () => {
      for (let i = 0; i < 50 && pendingGap.length === 0; i += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      }
      const next = pendingGap.shift()
      if (!next) return false
      await act(async () => { next.resolve() })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      return true
    }

    const host = await mount()
    await wait(host, (p) => p.count === 20 && p.status === 'success', 'initial 20')

    latestRev = 2
    let slideRefetch: Promise<unknown> = Promise.resolve()
    await act(async () => {
      slideRefetch = probe(host).q.refetch()
    })
    // Controlled async ≥3 gap pages; do not await slideRefetch yet (still gated).
    expect(await releaseOne()).toBe(true)
    expect(beforeHits[0]).toBe('g0')
    expect(await releaseOne()).toBe(true)
    expect(await releaseOne()).toBe(true)
    expect(beforeHits.length).toBeGreaterThanOrEqual(3)
    expect(probe(host).gap).toBe(true)
    expect(probe(host).count).toBeGreaterThanOrEqual(80)
    const completedBeforeLatest = new Set(beforeHits)

    // Same latest while gap open — must keep resume, not re-hit completed cursors.
    const beforeSame = beforeHits.length
    let sameRefetch: Promise<unknown> = Promise.resolve()
    await act(async () => {
      sameRefetch = probe(host).q.refetch()
    })
    for (let i = 0; i < 20; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
    const afterSame = beforeHits.slice(beforeSame)
    for (const hit of afterSame) {
      expect(completedBeforeLatest.has(hit)).toBe(false)
    }
    expect(beforeHits.filter((c) => c === 'g0').length).toBe(1)
    expect(probe(host).gap).toBe(true)

    // Open the gate and finish multi-batch fill.
    openGate = true
    while (pendingGap.length > 0) {
      await releaseOne()
    }
    await act(async () => { await slideRefetch })
    await act(async () => { await sameRefetch })
    for (let i = 0; i < 20 && probe(host).gap; i += 1) {
      await act(async () => {
        try { await probe(host).q.retryMessageGap() } catch { /* ignore */ }
      })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
    }
    await wait(host, (p) => !p.gap && p.count >= 261, 'gap closed full bridge')
    expect(probe(host).count).toBe(261)
    const counts = beforeHits.reduce<Record<string, number>>((acc, c) => {
      acc[c] = (acc[c] ?? 0) + 1
      return acc
    }, {})
    for (const [cursor, n] of Object.entries(counts)) {
      expect(n, `cursor ${cursor} re-fetched`).toBe(1)
    }
  }, 15_000)

  test('full double-slide sequence closes only after earliest targets; late old cannot advance new cursor', async () => {
    const { applyContactLatestPage, applyContactGapPage } = await import('./assistantContactMessages')
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i))
    const first = applyContactLatestPage(null, envelope(range(1, 20), {
      nextCursor: 'c0', complete: false, revision: 1,
    }))
    const a = applyContactLatestPage(first, envelope(range(102, 121), {
      nextCursor: 'gap-a', complete: false, revision: 2,
    }))
    expect(a.hasMessageGap).toBe(true)
    const requestA = [...(a.gapRequestIDs ?? [])]
    const targets = [...(a.gapTargetIDs ?? [])]
    const b = applyContactLatestPage(a, envelope(range(222, 241), {
      nextCursor: 'gap-b', complete: false, revision: 3,
    }))
    expect(b.hasMessageGap).toBe(true)
    expect(b.gapCursor).toBe('gap-b')
    expect(b.gapTargetIDs).toEqual(targets)
    const requestB = [...(b.gapRequestIDs ?? [])]
    expect(requestB).not.toEqual(requestA)

    const lateOld = applyContactGapPage(b, envelope(range(2, 21), {
      nextCursor: null, complete: true, revision: 3,
    }), { requestIDs: requestA, cursor: 'gap-a' })
    expect(lateOld.hasMessageGap).toBe(true)
    expect(lateOld.gapCursor).toBe('gap-b')

    // New fill walks entire bridge; mid 102..121 must stay open until earliest 1..20.
    let view = lateOld
    for (const start of [202, 182, 162, 142, 122, 102, 82, 62, 42, 22]) {
      view = applyContactGapPage(view, envelope(range(start, start + 19), {
        nextCursor: `g${start}`, complete: false, revision: 3,
      }), { requestIDs: requestB })
      expect(view.hasMessageGap, `open after ${start}`).toBe(true)
    }
    view = applyContactGapPage(view, envelope(range(2, 21), {
      nextCursor: null, complete: true, revision: 3,
    }), { requestIDs: requestB })
    expect(view.hasMessageGap).toBe(false)
    expect(view.messages.map((m) => m.ordinal)).toEqual(Array.from({ length: 241 }, (_, i) => i + 1))
  })
})
