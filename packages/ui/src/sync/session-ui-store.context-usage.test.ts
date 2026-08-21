import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionUIStore } from './session-ui-store';

/**
 * getContextUsage must treat a compaction row newer than the last
 * token-bearing assistant as a baseline reset: the transcript keeps the
 * compacted history, so the stale pre-compaction assistant would otherwise
 * win the backward scan and the header ring would never refresh after
 * `/compact`.
 */
const refs = vi.hoisted(() => ({
  sessionId: 'ses_ctx_usage' as string | null,
  messages: [] as Array<Record<string, unknown>>,
  partsByMessage: new Map<string, unknown[]>(),
}));

vi.mock('./sync-refs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSyncMessages: (sessionId: string) => (sessionId === refs.sessionId ? refs.messages : []),
    getSyncParts: (messageId: string) => refs.partsByMessage.get(messageId),
  };
});

const TOKENS = { input: 90000, output: 500, reasoning: 100, cache: { read: 10, write: 20 } };

describe('getContextUsage compaction baseline', () => {
  beforeEach(() => {
    refs.sessionId = 'ses_ctx_usage';
    refs.messages = [];
    refs.partsByMessage = new Map();
    useSessionUIStore.setState({ currentSessionId: 'ses_ctx_usage', newSessionDraft: undefined });
  });

  test('returns the last token-bearing assistant baseline', () => {
    refs.messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
    ];

    const usage = useSessionUIStore.getState().getContextUsage(200000, 1000);
    expect(usage?.totalTokens).toBe(90630);
    expect(usage?.lastMessageId).toBe('a1');
    expect(usage?.percentage).toBe(45);
  });

  test('returns null after compaction until a post-compaction assistant publishes tokens', () => {
    refs.messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
    ];
    refs.partsByMessage.set('u-compact', [{ type: 'compaction' }]);

    expect(useSessionUIStore.getState().getContextUsage(200000, 1000)).toBeNull();
  });

  test('a post-compaction assistant with tokens becomes the new baseline', () => {
    refs.messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
      { id: 'a2', role: 'assistant', tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
    ];
    refs.partsByMessage.set('u-compact', [{ type: 'compaction' }]);

    const usage = useSessionUIStore.getState().getContextUsage(200000, 1000);
    expect(usage?.totalTokens).toBe(1050);
    expect(usage?.lastMessageId).toBe('a2');
  });

  test('returns null without messages', () => {
    refs.messages = [];
    expect(useSessionUIStore.getState().getContextUsage(200000, 1000)).toBeNull();
  });
});
