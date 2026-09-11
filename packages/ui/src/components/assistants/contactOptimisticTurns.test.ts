import { describe, expect, test } from 'vitest'
import { AssistantAPIError, type AssistantContactMessage } from '@/queries/assistantDTO'
import {
  admitContactTurnPreview,
  applyContactBubbleDelta,
  beginContactComposerSubmit,
  contactOptimisticSending,
  contactTurnPreviewWorking,
  contactSendErrorMessage,
  createContactOptimisticTurn,
  createContactSendGate,
  endContactTurnPreview,
  markContactOptimisticAdmitted,
  markContactOptimisticFailed,
  mergeContactTranscript,
  reconcileContactOptimisticTurns,
  reconcileContactTurnPreviews,
  scopeContactOptimisticTurns,
  applyServerContactTurnAuthority,
  seedContactTurnPreviewFromServer,
} from './contactOptimisticTurns'

const serverMessage = (messageID: string, text: string): AssistantContactMessage => ({
  messageID,
  assistantID: 'asst_1',
  role: 'user',
  turnID: messageID,
  bubbleIndex: 0,
  createdAt: 1,
  ordinal: 0,
  status: 'complete',
  fromAssistantID: null,
  fromAssistantName: null,
  parts: [{ type: 'text', text }],
  text,
  cards: [],
})

describe('contactOptimisticTurns', () => {
  test('appends an optimistic user bubble with text and file previews until the server id arrives', () => {
    const turn = createContactOptimisticTurn('asst_1', 'oc_contact_local', [
      { type: 'text', text: 'see this' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,eA==', filename: 'shot.png' },
    ], 42)
    const merged = mergeContactTranscript([], [turn], 'asst_1')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      messageID: 'oc_contact_local',
      role: 'user',
      status: 'sending',
      text: 'see this',
      createdAt: 42,
    })
    expect(merged[0].parts).toEqual(turn.parts)

    const authoritative = [serverMessage('oc_contact_local', 'see this')]
    expect(mergeContactTranscript(authoritative, [turn], 'asst_1')).toBe(authoritative)
    expect(reconcileContactOptimisticTurns([turn], authoritative)).toEqual([])
    expect(scopeContactOptimisticTurns([turn], 'asst_2')).toEqual([])
  })

  test('shows the sending marker only before admission and keeps processing separate from the user row', () => {
    const sendingTurn = createContactOptimisticTurn('asst_1', 'oc_contact_local', [{ type: 'text', text: 'hello' }], 42)
    const admittedTurn = markContactOptimisticAdmitted([sendingTurn], sendingTurn.messageID)
    const processing = admitContactTurnPreview([], 'asst_1', sendingTurn.messageID, 43)

    expect(contactOptimisticSending([sendingTurn])).toBe(true)
    expect(contactOptimisticSending(admittedTurn)).toBe(false)
    expect(contactTurnPreviewWorking(processing)).toBe(true)

    const authoritativeUser = [serverMessage(sendingTurn.messageID, 'hello')]
    expect(reconcileContactOptimisticTurns(admittedTurn, authoritativeUser)).toEqual([])
    expect(reconcileContactTurnPreviews(processing, authoritativeUser)).toBe(processing)

    const merged = mergeContactTranscript(authoritativeUser, admittedTurn, 'asst_1', processing)
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({
      role: 'assistant',
      turnID: sendingTurn.messageID,
      status: 'admitted',
      parts: [],
    })
  })

  test('appends real deltas by bubble index, freezes done bubbles, and reconciles after turn end plus authority', () => {
    let previews = admitContactTurnPreview([], 'asst_1', 'oc_contact_local', 42)
    previews = applyContactBubbleDelta(previews, {
      assistantID: 'asst_1', turnID: 'oc_contact_local', bubbleIndex: 0, delta: 'Hel', done: false, occurredAt: 43,
    })
    previews = applyContactBubbleDelta(previews, {
      assistantID: 'asst_1', turnID: 'oc_contact_local', bubbleIndex: 0, delta: 'lo', done: true, occurredAt: 44,
    })
    previews = applyContactBubbleDelta(previews, {
      assistantID: 'asst_1', turnID: 'oc_contact_local', bubbleIndex: 0, delta: ' ignored', done: true, occurredAt: 45,
    })
    previews = applyContactBubbleDelta(previews, {
      assistantID: 'asst_1', turnID: 'oc_contact_local', bubbleIndex: 1, delta: 'Next', done: false, occurredAt: 46,
    })
    expect(previews[0]).toMatchObject({
      status: 'streaming',
      bubbles: [
        { bubbleIndex: 0, text: 'Hello', done: true },
        { bubbleIndex: 1, text: 'Next', done: false },
      ],
    })
    const merged = mergeContactTranscript([serverMessage('oc_contact_local', 'hello')], [], 'asst_1', previews)
    expect(merged.slice(1).map((message) => ({ text: message.text, status: message.status }))).toEqual([
      { text: 'Hello', status: 'complete' },
      { text: 'Next', status: 'streaming' },
      { text: '', status: 'admitted' },
    ])
    expect(merged[merged.length - 1]?.messageID).toBe('oc_contact_local:preview:admitted')

    const authoritativeAssistant: AssistantContactMessage = {
      ...serverMessage('assistant_bubble_1', 'Hello'),
      role: 'assistant',
      turnID: 'oc_contact_local',
    }
    expect(reconcileContactTurnPreviews(previews, [authoritativeAssistant])).toBe(previews)
    const complete = endContactTurnPreview(previews, {
      assistantID: 'asst_1', turnID: 'oc_contact_local', status: 'complete', occurredAt: 47,
    })
    expect(contactTurnPreviewWorking(complete)).toBe(false)
    expect(mergeContactTranscript([serverMessage('oc_contact_local', 'hello')], [], 'asst_1', complete).slice(1).map((message) => message.status)).toEqual([
      'complete',
      'streaming',
    ])
    expect(reconcileContactTurnPreviews(complete, [authoritativeAssistant])).toEqual([])
  })

  test('marks a turn-end error as failed and stops processing', () => {
    const failed = endContactTurnPreview([], {
      assistantID: 'asst_1', turnID: 'oc_contact_local', status: 'error', error: 'upstream failed', occurredAt: 50,
    })
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'upstream failed' })
    expect(contactTurnPreviewWorking(failed)).toBe(false)
    expect(mergeContactTranscript([], [], 'asst_1', failed)[0]).toMatchObject({ role: 'assistant', status: 'failed' })
  })

  test('a later conversation drops a failed overlay so a timeout cannot trail', () => {
    const failed = endContactTurnPreview([], {
      assistantID: 'asst_1',
      turnID: 'turn_timeout',
      status: 'error',
      error: 'OpenCode LLM generate timed out after 90000ms',
      occurredAt: 1,
    })
    const wiped = [
      { ...serverMessage('turn_wipe', '清空历史记录与消息记录'), turnID: 'turn_wipe' },
      { ...serverMessage('turn_wipe:bubble:1', 'Chat history cleared.'), role: 'assistant' as const, turnID: 'turn_wipe' },
    ]
    expect(reconcileContactTurnPreviews(failed, wiped)).toEqual([])
    expect(mergeContactTranscript(wiped, [], 'asst_1', failed).some((message) => message.status === 'failed')).toBe(false)

    const nextTurn = admitContactTurnPreview(failed, 'asst_1', 'turn_hey', 2)
    expect(nextTurn.find((preview) => preview.status === 'failed')).toBeUndefined()
    expect(nextTurn.find((preview) => preview.turnID === 'turn_hey')?.status).toBe('admitted')

    const continued = [
      ...wiped,
      { ...serverMessage('turn_hey', 'hey!'), turnID: 'turn_hey' },
    ]
    const authority = applyServerContactTurnAuthority(failed, {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_hey', admittedAt: 2 },
      serverWorking: true,
      snapshotRevision: 20,
      messages: continued,
    })
    expect(authority.find((preview) => preview.status === 'failed')).toBeUndefined()
    expect(mergeContactTranscript(continued, [], 'asst_1', [...failed, ...authority]).some((message) => (
      message.status === 'failed' || (message.text || '').includes('timed out')
    ))).toBe(false)
  })

  test('seeds processing from server activeContactTurn and ignores stale ends for unknown turns', () => {
    const seeded = seedContactTurnPreviewFromServer([], {
      assistantID: 'asst_1',
      turnID: 'turn_server',
      admittedAt: 70,
    })
    expect(contactTurnPreviewWorking(seeded)).toBe(true)
    expect(seeded[0]).toMatchObject({ turnID: 'turn_server', status: 'admitted', occurredAt: 70 })

    const settled = new Set(['turn_done'])
    expect(seedContactTurnPreviewFromServer([], {
      assistantID: 'asst_1',
      turnID: 'turn_done',
      admittedAt: 71,
    }, settled)).toEqual([])

    const live = admitContactTurnPreview([], 'asst_1', 'turn_live', 80)
    const ignored = endContactTurnPreview(live, {
      assistantID: 'asst_1', turnID: 'turn_stale', status: 'complete', occurredAt: 81,
    }, { requireExisting: true })
    expect(ignored).toBe(live)
    expect(contactTurnPreviewWorking(ignored)).toBe(true)

    const ended = endContactTurnPreview(live, {
      assistantID: 'asst_1', turnID: 'turn_live', status: 'complete', occurredAt: 82,
    }, { requireExisting: true })
    expect(contactTurnPreviewWorking(ended)).toBe(false)
  })

  test('server idle clears covered local processing but not a newer send or pending send', () => {
    const busy = applyServerContactTurnAuthority([], {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_busy', admittedAt: 10 },
      serverWorking: true,
      snapshotRevision: 5,
    })
    expect(contactTurnPreviewWorking(busy)).toBe(true)
    expect(busy[0]?.turnID).toBe('turn_busy')

    const local = admitContactTurnPreview([], 'asst_1', 'turn_old', 1)
    const cleared = applyServerContactTurnAuthority(local, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 12,
      admissionRevisionByTurnID: new Map([['turn_old', 8]]),
    })
    expect(contactTurnPreviewWorking(cleared)).toBe(false)

    const keptNewer = applyServerContactTurnAuthority(local, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 7,
      admissionRevisionByTurnID: new Map([['turn_old', 8]]),
    })
    expect(contactTurnPreviewWorking(keptNewer)).toBe(true)

    const pending = applyServerContactTurnAuthority(local, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 99,
      pendingSendTurnIDs: new Set(['turn_old']),
    })
    expect(contactTurnPreviewWorking(pending)).toBe(true)
  })

  test('recovers durable server error rows without SSE and keeps multi-turn order', () => {
    const live = admitContactTurnPreview(
      admitContactTurnPreview([], 'asst_1', 'turn_a', 1),
      'asst_1',
      'turn_b',
      2,
    )
    const recovered = applyServerContactTurnAuthority(live, {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_b', admittedAt: 2 },
      serverWorking: true,
      snapshotRevision: 4,
      messages: [
        { role: 'assistant', turnID: 'turn_a', status: 'error', text: 'No connected model' },
      ],
      admissionRevisionByTurnID: new Map([['turn_a', 3], ['turn_b', 4]]),
    })
    expect(recovered.find((preview) => preview.turnID === 'turn_a')).toBeUndefined()
    expect(recovered.find((preview) => preview.turnID === 'turn_b')?.status).toBe('admitted')
    expect(contactTurnPreviewWorking(recovered)).toBe(true)

    const idleAfterMissedEnd = applyServerContactTurnAuthority(recovered, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 6,
      admissionRevisionByTurnID: new Map([['turn_a', 3], ['turn_b', 4]]),
      messages: [
        { role: 'assistant', turnID: 'turn_a', status: 'error', text: 'No connected model' },
        { role: 'assistant', turnID: 'turn_b', status: 'complete', text: 'done' },
      ],
    })
    expect(contactTurnPreviewWorking(idleAfterMissedEnd)).toBe(false)
  })

  test('keeps a failed turn and prefers the server error.message', () => {
    const turn = createContactOptimisticTurn('asst_1', 'oc_contact_local', [
      { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'notes.txt' },
    ])
    const failed = markContactOptimisticFailed([turn], 'oc_contact_local', 'generate timed out')
    expect(failed[0]).toMatchObject({
      messageID: 'oc_contact_local',
      status: 'failed',
      error: 'generate timed out',
    })
    expect(mergeContactTranscript([], failed, 'asst_1')[0]).toMatchObject({
      messageID: 'oc_contact_local',
      status: 'failed',
    })
    expect(contactSendErrorMessage(
      new AssistantAPIError('upstream_error', 502, undefined, 'generate timed out'),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.', timedOut: 'The model did not reply in time.' },
    )).toBe('generate timed out')
    expect(contactSendErrorMessage(
      new AssistantAPIError('upstream_error', 502),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.', timedOut: 'The model did not reply in time.' },
    )).toBe('Could not send that message.')
    expect(contactSendErrorMessage(
      new AssistantAPIError('no_provider', 400),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.', timedOut: 'The model did not reply in time.' },
    )).toBe('no provider')
    expect(contactSendErrorMessage(
      new AssistantAPIError('admission_timeout', 408),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.', timedOut: 'The model did not reply in time.' },
    )).toBe('The model did not reply in time.')
    expect(contactSendErrorMessage(
      new DOMException('The operation was aborted.', 'AbortError'),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.', timedOut: 'The model did not reply in time.' },
    )).toBe('The model did not reply in time.')
  })

  test('two rapid submit() attempts create one optimistic turn', () => {
    const gate = createContactSendGate()
    const input = {
      gate,
      sending: false,
      text: '乐观发图',
      attachments: [{ mime: 'image/png', url: 'data:image/png;base64,eA==', name: 'shot.png' }],
      assistantID: 'asst_1',
    }
    const first = beginContactComposerSubmit({ ...input, createMessageID: () => 'oc_contact_1' })
    const second = beginContactComposerSubmit({ ...input, createMessageID: () => 'oc_contact_2' })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.messageID).toBe('oc_contact_1')
      expect(first.parts).toEqual([
        { type: 'text', text: '乐观发图' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,eA==', filename: 'shot.png' },
      ])
    }
    expect(second).toEqual({ ok: false })
  })

  test('ignores submit while an optimistic turn is already sending without taking the lock', () => {
    const gate = createContactSendGate()
    const blocked = beginContactComposerSubmit({
      gate,
      sending: true,
      text: 'second',
      attachments: [],
      assistantID: 'asst_1',
      createMessageID: () => 'oc_contact_2',
    })
    expect(blocked).toEqual({ ok: false })
    expect(gate.tryAcquire()).toBe(true)
  })
})
