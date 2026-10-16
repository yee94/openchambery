import { describe, expect, test } from 'vitest'
import type { Event } from './types'
import { mergeSessionTranscript, shareSessionTranscriptData, type SessionTranscriptData } from './transcript-merge'
import { normalizeSessionProjectionMessage, reconcileFetched } from './session-projection-api'
import { normalizeOpenCodeEvent } from './opencode-event-normalizer'
import { QueryClient } from '@tanstack/react-query'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'

describe('native compaction transcript lifecycle', () => {
  test.each(['missing', 'misplaced'] as const)('production authority refresh repairs a %s checkpoint across retained pages', async (state) => {
    const scope = { directory: '/workspace', sessionID: 'ses_paged_compaction' }
    const row = (id: string, type = 'assistant') => normalizeSessionProjectionMessage(scope.sessionID, {
      id, type, time: { created: 10 }, content: [{ type: 'text', text: id }],
      ...(type === 'compaction' ? { status: 'completed', reason: 'auto' } : {}),
    })!
    const older = row('msg_older')
    const before = row('msg_before')
    const checkpoint = row('msg_z_checkpoint', 'compaction')
    const after = row('msg_a_after')
    const latest = row('msg_latest')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createQueryTranscriptRepository({
      client, transport: 'compaction-test', generation: 1,
      probe: { getTransport: () => 'compaction-test', getGeneration: () => 1 },
      fetcher: async () => ({ records: [before, checkpoint, after, latest], complete: false, cursor: 'older', turnCount: 0 }),
    })
    try {
      repo.apply(scope, { type: 'http-page', purpose: 'initial', page: {
        records: state === 'missing' ? [latest] : [latest, checkpoint], complete: false, cursor: 'before', turnCount: 0,
      } })
      repo.apply(scope, { type: 'http-page', purpose: 'prepend', page: { records: [older, before, after], complete: true, turnCount: 0 } })
      const oldData = client.getQueriesData<SessionTranscriptData>({ queryKey: ['compaction-test', 1, 'session-transcript'] })[0]?.[1]
      const retained = repo.getTranscript(scope).messagesByID[older.info.id]
      await repo.refreshFromAuthority(scope)
      expect(repo.getTranscript(scope).messageOrder).toEqual([older.info.id, before.info.id, checkpoint.info.id, after.info.id, latest.info.id])
      const newData = client.getQueriesData<SessionTranscriptData>({ queryKey: ['compaction-test', 1, 'session-transcript'] })[0]?.[1]
      expect(oldData).toBeDefined()
      expect(newData).toBeDefined()
      expect(shareSessionTranscriptData(oldData, newData, scope.sessionID)?.pages.flatMap(page => page.messageOrder))
        .toEqual([older.info.id, before.info.id, checkpoint.info.id, after.info.id, latest.info.id])
      expect(repo.getTranscript(scope).messagesByID[older.info.id]).toBe(retained)
      await repo.refreshFromAuthority(scope)
      expect(repo.getTranscript(scope).messageOrder).toEqual([older.info.id, before.info.id, checkpoint.info.id, after.info.id, latest.info.id])
      expect(repo.getPagination(scope).boundary.kind).toBe('exhausted')
    } finally {
      repo.destroy()
      client.clear()
    }
  })

  test.each(['missing', 'misplaced'] as const)('authority refresh repairs a %s checkpoint through reconciliation and Query sharing', (state) => {
    const sessionID = 'ses_refresh_order'
    const before = normalizeSessionProjectionMessage(sessionID, { id: 'msg_before', type: 'assistant', time: { created: 1 }, content: [] })!
    const checkpoint = normalizeSessionProjectionMessage(sessionID, { id: 'msg_checkpoint', type: 'compaction', time: { created: 2 }, status: 'completed', reason: 'auto' })!
    const after = normalizeSessionProjectionMessage(sessionID, { id: 'msg_after', type: 'assistant', time: { created: 3 }, content: [] })!
    const previous = state === 'missing' ? [before, after] : [before, after, checkpoint]
    const initial = mergeSessionTranscript(undefined, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: previous, complete: true, turnCount: 0 },
    }).data!
    const records = reconcileFetched({ fetched: [before, checkpoint, after], previous, completeTail: true })
    const recovered = mergeSessionTranscript(initial, sessionID, {
      type: 'http-page', purpose: 'reconcile-page', page: { records, complete: false, turnCount: 0 },
    }).data!
    const shared = shareSessionTranscriptData(initial, recovered, sessionID)
    expect(shared?.pages.flatMap(page => page.messageOrder)).toEqual([before.info.id, checkpoint.info.id, after.info.id])
  })

  test.each(['initial', 'recovery', 'reconcile-page'] as const)('a recovered checkpoint keeps authority order across equal clocks (%s)', (purpose) => {
    const sessionID = 'ses_checkpoint_order'
    const row = (id: string, type: string) => normalizeSessionProjectionMessage(sessionID, {
      id, type, time: { created: 10 },
      ...(type === 'compaction' ? { status: 'completed', reason: 'auto' } : { content: [{ type: 'text', text: id }] }),
    })!
    const before = row('msg_before', 'assistant')
    const checkpoint = row('msg_z_checkpoint', 'compaction')
    const after = row('msg_a_after', 'assistant')
    const initial = mergeSessionTranscript(undefined, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [before, after], complete: true, turnCount: 0 },
    }).data
    const recovered = mergeSessionTranscript(initial, sessionID, {
      type: 'http-page', purpose, page: { records: [before, checkpoint, after], complete: true, turnCount: 0 },
    }).data
    expect(recovered?.pages.flatMap(page => page.messageOrder)).toEqual([before.info.id, checkpoint.info.id, after.info.id])
  })

  test.each(['completed', 'failed'])('authoritative %s checkpoint releases the queue after a missed terminal event', async (status) => {
    const { rememberCompactionBarrierFromRecords, isCompactionBarrierActive, canPromoteInboxItem, resetSessionCompactionBarrier } = await import('./session-compaction-api')
    resetSessionCompactionBarrier()
    const sessionID = 'ses_queue_recovery'
    const checkpoint = (status: string) => normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_checkpoint', type: 'compaction', status, reason: 'auto',
      summary: '', time: { created: 10 },
    })!
    rememberCompactionBarrierFromRecords(sessionID, [checkpoint('running')])
    expect(isCompactionBarrierActive(sessionID)).toBe(true)
    rememberCompactionBarrierFromRecords(sessionID, [checkpoint(status)])
    expect(isCompactionBarrierActive(sessionID)).toBe(false)
    expect(canPromoteInboxItem({ sessionID })).toBe(true)
  })

  test.each(['recovery', 'prepend', 'new-start', 'late-running', 'failure'])(
    'production authority recovery respects queue lifecycle: %s', async (scenario) => {
      const { fetchProductionTranscriptTransportPage } = await import('./transcript-repository-production')
      const { setSessionCompactionBarrier, isCompactionBarrierActive, resetSessionCompactionBarrier } = await import('./session-compaction-api')
      const { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } = await import('../lib/runtime-url')
      const originalFetch = globalThis.fetch
      const resolver = getRuntimeUrlResolver()
      const sessionID = 'ses_production_queue'
      resetSessionCompactionBarrier()
      configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:57123' })
      setSessionCompactionBarrier(sessionID, true)
      globalThis.fetch = (async () => {
        if (scenario === 'failure') return new Response('unavailable', { status: 503 })
        if (scenario === 'new-start') setSessionCompactionBarrier(sessionID, true)
        if (scenario === 'late-running') setSessionCompactionBarrier(sessionID, false)
        return new Response(JSON.stringify({ data: [{
          id: 'msg_checkpoint', type: 'compaction', reason: 'auto',
          status: scenario === 'late-running' ? 'running' : 'completed',
          summary: '', time: { created: 10 },
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      try {
        const request = fetchProductionTranscriptTransportPage({
          directory: '/repo', sessionID, limit: 20,
          ...(scenario === 'prepend' ? { before: 'older-cursor' } : {}),
          signal: new AbortController().signal,
        })
        if (scenario === 'failure') await expect(request).rejects.toThrow()
        else await request
        expect(isCompactionBarrierActive(sessionID)).toBe(
          scenario !== 'recovery' && scenario !== 'late-running',
        )
      } finally {
        globalThis.fetch = originalFetch
        setRuntimeUrlResolver(resolver)
        resetSessionCompactionBarrier()
      }
    },
  )

  test('publishes live updates and keeps successive checkpoints separate', () => {
    const sessionID = 'ses_compact'
    const old = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_old', type: 'compaction', status: 'completed', reason: 'manual',
      summary: 'old summary', recent: '', time: { created: 1 },
    })!
    let data: SessionTranscriptData | undefined = mergeSessionTranscript(undefined, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [old], complete: true, turnCount: 0 },
    }).data
    const send = (type: string, properties: Record<string, unknown>, id = 'evt_new') => {
      data = mergeSessionTranscript(data, sessionID, {
        type: 'sse-event', event: { id, type, properties: { sessionID, eventCreated: 20, ...properties } } as Event,
      }).data
    }
    const part = (id: string) => data?.pages.flatMap(p => p.partsByMessageID[id] ?? [])[0]
    send('session.compaction.started', { reason: 'auto', recent: '' })
    expect(data?.pages.flatMap(p => p.messageOrder)).toEqual(['msg_old', 'msg_new'])
    expect(part('msg_new')).toMatchObject({ status: 'running' })
    expect(data?.pages[0]?.messagesByID.msg_new?.time.created).toBe(20)
    send('session.compaction.delta', { text: 'new summary' })
    expect(part('msg_new')).toMatchObject({ summary: 'new summary' })
    send('session.compaction.ended', { reason: 'auto', text: 'final summary', recent: '' })
    expect(part('msg_new')).toMatchObject({ status: 'completed', summary: 'final summary' })
    expect(part('msg_old')).toMatchObject({ status: 'completed', summary: 'old summary' })
    send('session.compaction.started', { reason: 'manual', inputID: 'msg_manual' }, 'evt_manual')
    send('session.compaction.failed', { reason: 'manual', error: { type: 'provider.internal', message: 'failed', status: 503 } })
    expect(part('msg_manual')).toMatchObject({ status: 'failed', error: { type: 'provider.internal', message: 'failed', status: 503 } })
    const history = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_manual', type: 'compaction', status: 'failed', reason: 'manual',
      error: { type: 'provider.internal', message: 'failed', status: 503 }, time: { created: 20 },
    })!
    expect(history.parts[0]).toMatchObject({ error: { type: 'provider.internal', message: 'failed', status: 503 } })
    send('session.compaction.delta', { text: 'late' })
    expect(part('msg_manual')).toMatchObject({ status: 'failed' })
  })

  test('batched events and history refresh retain the checkpoint identity and final content', () => {
    const sessionID = 'ses_batch'
    const row = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_checkpoint', type: 'compaction', status: 'running', reason: 'manual',
      summary: '', recent: '', time: { created: 10 },
    })!
    const initial = mergeSessionTranscript(undefined, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [row], complete: true, turnCount: 0 },
    }).data
    const batch = mergeSessionTranscript(initial, sessionID, {
      type: 'sse-event-batch', events: [
        { type: 'session.compaction.delta', properties: { sessionID, text: 'partial' } },
        { type: 'session.compaction.ended', properties: { sessionID, reason: 'manual', text: 'summary', recent: 'tail' } },
      ] as Event[],
    }).data
    expect(batch?.pages[0]?.messageOrder).toEqual(['msg_checkpoint'])
    expect(batch?.pages[0]?.partsByMessageID.msg_checkpoint?.[0]).toMatchObject({ status: 'completed', summary: 'summary' })
    const final = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_checkpoint', type: 'compaction', status: 'completed', reason: 'manual',
      summary: 'authoritative summary', recent: 'tail', time: { created: 10 },
    })!
    const refreshed = mergeSessionTranscript(batch, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [final], complete: true, turnCount: 0 },
    }).data
    expect(refreshed?.pages[0]?.messageOrder).toEqual(['msg_checkpoint'])
    expect(refreshed?.pages[0]?.partsByMessageID.msg_checkpoint?.[0]).toMatchObject({ status: 'completed', summary: 'authoritative summary' })
  })

  test('a completion arriving after its authoritative HTTP snapshot does not create a second checkpoint', () => {
    const sessionID = 'ses_race'
    const row = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_start', type: 'compaction', status: 'completed', reason: 'auto',
      summary: 'summary', recent: '', time: { created: 10 },
    })!
    const initial = mergeSessionTranscript(undefined, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [row], complete: true, turnCount: 0 },
    }).data
    const completed = mergeSessionTranscript(initial, sessionID, {
      type: 'sse-event', event: {
        id: 'evt_end', type: 'session.compaction.ended',
        properties: { sessionID, eventCreated: 20, reason: 'auto', text: 'summary', recent: '' },
      } as Event,
    }).data
    expect(completed?.pages.flatMap(page => page.messageOrder)).toEqual(['msg_start'])
  })

  test.each(['session.compaction.ended', 'session.compaction.failed'])('a missed start uses terminal recovery for %s, not an event-ID checkpoint', type => {
    const sessionID = 'ses_missed'
    const normalized = normalizeOpenCodeEvent({
      id: 'evt_end', type, created: 20,
      data: { sessionID, reason: 'auto', text: 'summary', recent: '' },
    })
    expect(normalized).toMatchObject({ action: 'emit', event: { domainActivityHint: { sessionID, kind: 'terminal' } } })
    if (normalized.action !== 'emit') throw new Error('Expected terminal event')
    const missed = mergeSessionTranscript(undefined, sessionID, {
      type: 'sse-event', event: normalized.event as Event,
    }).data
    expect(missed?.pages.flatMap(page => page.messageOrder) ?? []).toEqual([])
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_start', type: 'compaction', status: type.endsWith('failed') ? 'failed' : 'completed',
      reason: 'auto', summary: 'summary', time: { created: 10 },
    })!
    const recovered = mergeSessionTranscript(missed, sessionID, {
      type: 'http-page', purpose: 'initial', page: { records: [checkpoint], complete: true, turnCount: 0 },
    }).data
    expect(recovered?.pages.flatMap(page => page.messageOrder)).toEqual(['msg_start'])
  })
})
