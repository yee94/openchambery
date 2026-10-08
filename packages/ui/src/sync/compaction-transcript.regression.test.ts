import { describe, expect, test } from 'vitest'
import type { Event } from './types'
import { mergeSessionTranscript, type SessionTranscriptData } from './transcript-merge'
import { normalizeSessionProjectionMessage } from './session-projection-api'
import { normalizeOpenCodeEvent } from './opencode-event-normalizer'

describe('native compaction transcript lifecycle', () => {
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
