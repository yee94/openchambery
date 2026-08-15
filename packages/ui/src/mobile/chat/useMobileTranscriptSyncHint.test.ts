import { describe, expect, test } from 'bun:test';

import { resolveMobileTranscriptSyncHint } from './useMobileTranscriptSyncHint';

const idle = {
  sessionId: 'ses_1',
  hasTranscript: true,
  loadStatus: 'ready' as const,
  userRefreshInFlight: false,
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
      isConnected: false,
      connectionPhase: 'reconnecting',
    })).toBe('syncing');

    expect(resolveMobileTranscriptSyncHint({
      ...idle,
      hasTranscript: false,
      loadStatus: 'loading',
    })).toBe('syncing');
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
