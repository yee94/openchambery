import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{
    id: string;
    role: 'user' | 'assistant';
    time: { created: number };
  }>,
}));

vi.mock('@/sync/session-ui-store', () => {
  const state = {
    currentSessionId: 'session-1',
    currentSessionDirectory: '/repo',
    pendingSendMessageIDs: new Map<string, string>(),
    sessionAbortFlags: new Map(),
  };
  const useSessionUIStore = Object.assign(
    <T,>(selector: (value: typeof state) => T) => selector(state),
    { getState: () => state },
  );
  return { useSessionUIStore };
});

vi.mock('@/sync/sync-context', () => ({
  useSessionMessages: () => mocks.messages,
  useSessionParts: () => [],
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
  useSessionStatus: () => ({ type: 'busy' }),
}));

vi.mock('@/components/chat/lib/messageDisplayNormalization', () => ({
  isCompactionCommandParts: () => false,
}));

vi.mock('@/lib/messages/synthetic', () => ({
  isFullySyntheticMessage: () => false,
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('./useSessionActivity', () => ({
  useSessionActivity: () => ({ phase: 'busy', isWorking: true }),
}));

import { useAssistantStatus } from './useAssistantStatus';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.messages = [];
  document.body.innerHTML = '';
});

describe('useAssistantStatus turn start', () => {
  test('uses the latest user message server creation timestamp', async () => {
    const serverTurnStartedAt = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(serverTurnStartedAt + 82_000);
    mocks.messages = [
      { id: 'user-older', role: 'user', time: { created: serverTurnStartedAt - 30_000 } },
      { id: 'assistant-older', role: 'assistant', time: { created: serverTurnStartedAt - 20_000 } },
      { id: 'user-current', role: 'user', time: { created: serverTurnStartedAt } },
      { id: 'assistant-current', role: 'assistant', time: { created: serverTurnStartedAt + 1_000 } },
    ];

    let turnStartedAt: number | undefined;
    const Probe = () => {
      turnStartedAt = useAssistantStatus('session-1', '/repo').working.turnStartedAt;
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });

    expect(turnStartedAt).toBe(serverTurnStartedAt);
    expect(turnStartedAt).not.toBe(Date.now());

    await act(async () => {
      root.unmount();
    });
  });
});
