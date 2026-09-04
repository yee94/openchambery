import { describe, expect, test } from 'vitest'
import { AssistantAPIError, type AssistantContactMessage } from '@/queries/assistantDTO'
import {
  contactSendErrorMessage,
  createContactOptimisticTurn,
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
      { noProvider: 'no provider', sendFailed: 'Could not send that message.' },
    )).toBe('generate timed out')
    expect(contactSendErrorMessage(
      new AssistantAPIError('upstream_error', 502),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.' },
    )).toBe('Could not send that message.')
    expect(contactSendErrorMessage(
      new AssistantAPIError('no_provider', 400),
      { noProvider: 'no provider', sendFailed: 'Could not send that message.' },
    )).toBe('no provider')
  })
})
