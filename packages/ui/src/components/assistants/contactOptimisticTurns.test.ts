import { describe, expect, test } from 'vitest'
import { AssistantAPIError, type AssistantContactMessage } from '@/queries/assistantDTO'
import {
  beginContactComposerSubmit,
  contactSendErrorMessage,
  createContactOptimisticTurn,
  createContactSendGate,
  markContactOptimisticFailed,
  mergeContactTranscript,
  reconcileContactOptimisticTurns,
  scopeContactOptimisticTurns,
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
      new AssistantAPIError('generate_timeout', 408),
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
