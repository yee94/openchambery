import { describe, expect, test } from 'vitest';

import {
  applyLynxContactBubbleDelta,
  composeLynxContactTimeline,
  createLynxContactOptimisticTurn,
  createLynxContactPreviewState,
  markLynxContactOptimisticAdmitted,
  markLynxContactOptimisticFailed,
  mergeLynxContactTranscript,
  pagesAfterLynxContactHistoryRefresh,
  reconcileLynxContactOptimisticTurns,
  reconcileLynxContactTurnPreviews,
  reduceLynxContactTurnEvent,
} from './contactOptimistic';
import type { LynxAssistantHistoryPage } from './contactMessages';
import type { LynxContactChatMessage } from './contactDisplay';

const historyPage = (
  messages: { id: string; role: 'user' | 'assistant'; text: string; created?: number }[],
): LynxAssistantHistoryPage => ({
  entries: messages.map((message) => ({
    sessionID: 'ses_1',
    directory: '/work',
    info: {
      id: message.id,
      sessionID: 'ses_1',
      role: message.role,
      time: { created: message.created ?? 1 },
    },
    parts: [{
      id: `${message.id}:p`,
      sessionID: 'ses_1',
      messageID: message.id,
      type: 'text',
      text: message.text,
    }],
  })),
  nextCursor: null,
  complete: true,
});

const userMessage = (id: string, text: string): LynxContactChatMessage => ({
  info: { id, role: 'user', time: { created: 1 } },
  parts: [{ type: 'text', text }],
  kind: 'message',
});

describe('optimistic send status', () => {
  test('sending becomes admitted, then failed without dropping the row', () => {
    const created = createLynxContactOptimisticTurn('asst_1', 'msg_1', 'hello', 5);
    expect(created.status).toBe('sending');
    const admitted = markLynxContactOptimisticAdmitted([created], 'msg_1');
    expect(admitted[0]?.status).toBe('admitted');
    const failed = markLynxContactOptimisticFailed(admitted, 'msg_1', 'admit failed (500)');
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'admit failed (500)', text: 'hello' });
    expect(reconcileLynxContactOptimisticTurns(failed, [])).toHaveLength(1);
    expect(reconcileLynxContactOptimisticTurns(failed, [{ id: 'msg_1', role: 'user' }])).toEqual([]);
  });
});

describe('contact preview merge', () => {
  test('folds bubble deltas into preview rows on the same transcript', () => {
    let previews = applyLynxContactBubbleDelta([], {
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 1,
      delta: 'B',
      done: false,
      occurredAt: 3,
    });
    previews = applyLynxContactBubbleDelta(previews, {
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 0,
      delta: 'A',
      done: false,
      occurredAt: 2,
    });
    previews = applyLynxContactBubbleDelta(previews, {
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 0,
      delta: 'a',
      done: true,
      occurredAt: 4,
    });
    expect(previews[0]?.status).toBe('streaming');
    expect(previews[0]?.bubbles.map((bubble) => bubble.text)).toEqual(['Aa', 'B']);

    const merged = mergeLynxContactTranscript(
      [userMessage('msg_1', 'hello')],
      [],
      'asst_1',
      previews,
    );
    expect(merged.map((message) => message.info.id)).toEqual([
      'msg_1',
      'msg_1:preview:0',
      'msg_1:preview:1',
      'msg_1:preview:admitted',
    ]);
  });

  test('reconciles complete previews once authoritative history has the assistant reply', () => {
    const streaming = applyLynxContactBubbleDelta([], {
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 0,
      delta: 'Hello',
      done: true,
      occurredAt: 2,
    });
    const ended = reduceLynxContactTurnEvent(
      { previews: streaming, settledTurnIDs: new Set() },
      {
        type: 'contact-turn-end',
        assistantID: 'asst_1',
        turnID: 'msg_1',
        status: 'complete',
        occurredAt: 3,
      },
    );
    const covered = reconcileLynxContactTurnPreviews(ended.previews, [
      { id: 'msg_1', role: 'user', text: 'hello' },
      { id: 'asst_reply', role: 'assistant', text: 'Hello' },
    ]);
    expect(covered).toEqual([]);

    const page = historyPage([
      { id: 'msg_1', role: 'user', text: 'hello' },
      { id: 'asst_reply', role: 'assistant', text: 'Hello', created: 2 },
    ]);
    const composed = composeLynxContactTimeline({
      pages: [page],
      sessionID: 'ses_1',
      assistantID: 'asst_1',
      optimistic: [],
      previews: ended.previews,
    });
    expect(composed.entries.map((entry) => entry.messageId)).toEqual(['msg_1', 'asst_reply']);
    expect(composed.working).toBe(false);
  });

  test('keeps a failed history refresh from erasing the optimistic transcript', () => {
    const page = historyPage([{ id: 'older', role: 'user', text: 'before', created: 1 }]);
    const current = [page];
    const failed = pagesAfterLynxContactHistoryRefresh(current, {
      status: 'failed',
      error: new Error('assistant messages failed (503)'),
      httpStatus: 503,
    });
    expect(failed).toBe(current);
    const optimistic = [createLynxContactOptimisticTurn('asst_1', 'msg_new', 'pending', 9)];
    const composed = composeLynxContactTimeline({
      pages: failed,
      sessionID: 'ses_1',
      assistantID: 'asst_1',
      optimistic,
      previews: [],
    });
    expect(composed.entries.map((entry) => entry.messageId)).toEqual(['older', 'msg_new']);
    expect(composed.entries[1]?.text).toBe('pending');
    expect(composed.working).toBe(true);
  });

  test('turn-end without a tracked preview does not invent a failed row', () => {
    const next = reduceLynxContactTurnEvent(createLynxContactPreviewState(), {
      type: 'contact-turn-end',
      assistantID: 'asst_1',
      turnID: 'msg_missing',
      status: 'error',
      error: 'nope',
      occurredAt: 1,
    });
    expect(next.previews).toEqual([]);
  });

  test('late bubble deltas after turn-end do not reopen the preview', () => {
    let state = reduceLynxContactTurnEvent(createLynxContactPreviewState(), {
      type: 'contact-turn-start',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      messageID: 'msg_1',
      occurredAt: 1,
    });
    state = reduceLynxContactTurnEvent(state, {
      type: 'contact-bubble-delta',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 0,
      delta: 'Hi',
      done: false,
      occurredAt: 2,
    });
    state = reduceLynxContactTurnEvent(state, {
      type: 'contact-turn-end',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      status: 'complete',
      occurredAt: 3,
    });
    const after = reduceLynxContactTurnEvent(state, {
      type: 'contact-bubble-delta',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      bubbleIndex: 0,
      delta: '!',
      done: false,
      occurredAt: 4,
    });
    expect(after).toBe(state);
    expect(after.previews[0]?.bubbles[0]?.text).toBe('Hi');
  });
});
