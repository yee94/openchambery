import { describe, expect, test } from 'bun:test';

import { resolveMobileTranscriptSyncHint } from './useMobileTranscriptSyncHint';

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
