import { describe, expect, test } from 'vitest';

import {
  createLynxSyncHintSmoother,
  deriveLynxTranscriptLoadStatus,
  mapLynxLiveConnectionToSyncPhase,
  resolveLynxTranscriptSyncHint,
} from './transcriptSyncHint';

const idle = {
  sessionId: 'ses_1',
  hasTranscript: true,
  loadStatus: 'ready' as const,
  userRefreshInFlight: false,
  backgroundResyncInFlight: false,
  isConnected: true,
  connectionPhase: 'connected' as const,
};

describe('resolveLynxTranscriptSyncHint', () => {
  test('hides on drafts and idle connected chats', () => {
    expect(resolveLynxTranscriptSyncHint({ ...idle, sessionId: '' })).toBeNull();
    expect(resolveLynxTranscriptSyncHint(idle)).toBeNull();
  });

  test('shows for user refresh, reconnect, and cold first paint only', () => {
    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      userRefreshInFlight: true,
    })).toBe('syncing');

    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      hasTranscript: false,
      loadStatus: 'error',
      isConnected: false,
      connectionPhase: 'reconnecting',
    })).toBe('syncing');

    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      hasTranscript: false,
      loadStatus: 'loading',
    })).toBe('syncing');
  });

  test('hides once messages are present after a finished refresh', () => {
    expect(resolveLynxTranscriptSyncHint({
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
    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      backgroundResyncInFlight: true,
    })).toBe('syncing');
  });

  test('ignores warm prefetch loading and first-connect splash', () => {
    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      loadStatus: 'loading',
    })).toBeNull();

    expect(resolveLynxTranscriptSyncHint({
      ...idle,
      isConnected: false,
      connectionPhase: 'connecting',
    })).toBeNull();
  });
});

describe('createLynxSyncHintSmoother', () => {
  const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeSmoother() {
    const events: boolean[] = [];
    const smoother = createLynxSyncHintSmoother(
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
    smoother.setRaw(false);
    await flush(30);
    smoother.setRaw(true);
    await flush(150);
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

describe('Lynx portable mappers', () => {
  test('deriveLynxTranscriptLoadStatus from hydrate/error', () => {
    expect(deriveLynxTranscriptLoadStatus({
      hydrated: false,
      initialError: null,
    })).toBe('loading');
    expect(deriveLynxTranscriptLoadStatus({
      hydrated: true,
      initialError: null,
    })).toBe('ready');
    expect(deriveLynxTranscriptLoadStatus({
      hydrated: false,
      initialError: 'boom',
    })).toBe('error');
  });

  test('mapLynxLiveConnectionToSyncPhase', () => {
    expect(mapLynxLiveConnectionToSyncPhase('connecting', true)).toEqual({
      isConnected: false,
      connectionPhase: 'connecting',
    });
    expect(mapLynxLiveConnectionToSyncPhase('reconnecting', true)).toEqual({
      isConnected: false,
      connectionPhase: 'reconnecting',
    });
    expect(mapLynxLiveConnectionToSyncPhase('open', true)).toEqual({
      isConnected: true,
      connectionPhase: 'connected',
    });
    expect(mapLynxLiveConnectionToSyncPhase('idle', false)).toEqual({
      isConnected: false,
      connectionPhase: 'connecting',
    });
  });
});
