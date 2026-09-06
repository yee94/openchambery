import { describe, expect, it } from 'vitest';

import {
  applyHomeAttentionEvent,
  buildUnseenBySession,
  emptyHomeAttentionState,
  markSessionViewed,
  runningSessionIdsFromState,
  setViewingSession,
  snapshotHomeAttention,
} from '@/lib/homeAttention';
import type { OpenChamberEvent } from '@/lib/eventStream';

const ev = (type: string, properties: Record<string, unknown>): OpenChamberEvent => ({
  type,
  properties,
});

describe('homeAttention', () => {
  it('tracks busy/retry running ids and clears on idle', () => {
    let state = emptyHomeAttentionState();
    state = applyHomeAttentionEvent(
      state,
      ev('session.status', { sessionID: 's1', status: { type: 'busy' } }),
    );
    expect([...runningSessionIdsFromState(state.runningById)]).toEqual(['s1']);

    state = applyHomeAttentionEvent(
      state,
      ev('session.status', { sessionID: 's2', status: { type: 'retry' } }),
    );
    expect(snapshotHomeAttention(state).runningSessionIds.has('s2')).toBe(true);

    state = applyHomeAttentionEvent(state, ev('session.idle', { sessionID: 's1' }));
    expect(state.runningById.s1).toBeUndefined();
    expect(state.runningById.s2).toBe('retry');
  });

  it('appends turn-complete on idle and counts unseen', () => {
    let state = emptyHomeAttentionState();
    state = applyHomeAttentionEvent(
      state,
      ev('session.idle', { sessionID: 'unread-1', directory: '/code' }),
      { now: () => 1000 },
    );
    expect(buildUnseenBySession(state.notifications)).toEqual({ 'unread-1': 1 });

    state = applyHomeAttentionEvent(
      state,
      ev('session.idle', { sessionID: 'unread-1' }),
      { now: () => 2000 },
    );
    expect(buildUnseenBySession(state.notifications)).toEqual({ 'unread-1': 2 });
  });

  it('marks idle as viewed when that session is open', () => {
    let state = setViewingSession(emptyHomeAttentionState(), 'open-1');
    state = applyHomeAttentionEvent(
      state,
      ev('session.idle', { sessionID: 'open-1' }),
      { now: () => 1 },
    );
    expect(buildUnseenBySession(state.notifications)).toEqual({});
    expect(state.notifications[0]?.viewed).toBe(true);
  });

  it('markSessionViewed clears unseen for that session', () => {
    let state = applyHomeAttentionEvent(
      emptyHomeAttentionState(),
      ev('session.error', { sessionID: 'err-1' }),
      { now: () => 1 },
    );
    expect(buildUnseenBySession(state.notifications)['err-1']).toBe(1);
    state = markSessionViewed(state, 'err-1');
    expect(buildUnseenBySession(state.notifications)).toEqual({});
  });

  it('setViewingSession marks existing unseen as viewed', () => {
    let state = applyHomeAttentionEvent(
      emptyHomeAttentionState(),
      ev('session.idle', { sessionID: 's1' }),
      { now: () => 1 },
    );
    state = setViewingSession(state, 's1');
    expect(buildUnseenBySession(state.notifications)).toEqual({});
  });

  it('normalizes string status busy/running', () => {
    let state = applyHomeAttentionEvent(
      emptyHomeAttentionState(),
      ev('session.status', { sessionID: 'a', status: 'running' }),
    );
    expect(state.runningById.a).toBe('busy');
    state = applyHomeAttentionEvent(
      state,
      ev('session.status', { sessionID: 'a', status: 'idle' }),
    );
    expect(state.runningById.a).toBeUndefined();
  });
});
