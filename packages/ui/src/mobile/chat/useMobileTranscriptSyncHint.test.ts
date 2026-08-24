import { describe, expect, test } from 'bun:test';

import {
  createSyncHintSmoother,
  resolveMobileTranscriptSyncHint,
} from './useMobileTranscriptSyncHint';

const idle = {
  sessionId: 'ses_1',
  hasTranscript: true,
  loadStatus: 'ready' as const,
  userRefreshInFlight: false,
  backgroundResyncInFlight: false,
  isConnected: true,
  connectionPhase: 'connected' as const,
};

describe('resolveMobileTranscriptSyncHint', () => {
  test('hides on drafts and idle connected chats', () => {
    expect(resolveMobileTranscriptSyncHint({ ...idle, sessionId: '' })).toBeNull();
    expect(resolveMobileTranscriptSyncHint(idle)).toBeNull();
  });

  test('shows for user refresh, reconnect, and cold first paint only', () => {
    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      userRefreshInFlight: true,
    })).toBe('syncing');

    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      hasTranscript: false,
      loadStatus: 'error',
      isConnected: false,
      connectionPhase: 'reconnecting',
    })).toBe('syncing');

    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      hasTranscript: false,
      loadStatus: 'loading',
    })).toBe('syncing');
  });

  test('hides once messages are present after a finished refresh', () => {
    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      hasTranscript: true,
      loadStatus: 'loading',
      userRefreshInFlight: false,
      backgroundResyncInFlight: false,
      isConnected: false,
      connectionPhase: 'reconnecting',
    })).toBeNull();
  });

  test('shows during background resync even with a warm transcript', () => {
    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      backgroundResyncInFlight: true,
    })).toBe('syncing');

    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      backgroundResyncInFlight: true,
      isConnected: false,
      connectionPhase: 'reconnecting',
      loadStatus: 'ready',
    })).toBe('syncing');
  });

  test('hides once the background resync flight ends', () => {
    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      backgroundResyncInFlight: false,
      isConnected: false,
      connectionPhase: 'reconnecting',
    })).toBeNull();
  });

  test('ignores warm prefetch loading and first-connect splash', () => {
    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      loadStatus: 'loading',
    })).toBeNull();

    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      isConnected: false,
      connectionPhase: 'connecting',
    })).toBeNull();
  });
});

describe('createSyncHintSmoother', () => {
  const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeSmoother() {
    const events: boolean[] = [];
    const smoother = createSyncHintSmoother(
      (visible) => events.push(visible),
      { showDelayMs: 20, hideGraceMs: 60 },
    );
    return { smoother, events };
  }

  test('blip shorter than the show delay never renders', async () => {
    const { smoother, events } = makeSmoother();
    smoother.setRaw(true);
    await flush(5);
    smoother.setRaw(false);
    await flush(120);
    expect(events).toEqual([]);
  });

  test('sustained work shows after the show delay', async () => {
    const { smoother, events } = makeSmoother();
    smoother.setRaw(true);
    await flush(5);
    expect(events).toEqual([]);
    await flush(60);
    expect(events).toEqual([true]);
  });

  test('relayed flights within the hide grace stay one continuous display', async () => {
    const { smoother, events } = makeSmoother();
    smoother.setRaw(true);
    await flush(80);
    expect(events).toEqual([true]);
    // Flight A ends, flight B begins 30ms later (grace is 60ms).
    smoother.setRaw(false);
    await flush(30);
    smoother.setRaw(true);
    await flush(150);
    // Still exactly one appearance; the between-flights gap never painted.
    expect(events).toEqual([true]);
    smoother.setRaw(false);
    await flush(120);
    expect(events).toEqual([true, false]);
  });

  test('cancel drops pending transitions', async () => {
    const { smoother, events } = makeSmoother();
    smoother.setRaw(true);
    smoother.cancel();
    await flush(80);
    expect(events).toEqual([]);
  });
});
