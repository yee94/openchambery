import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{
    id: string;
    role: 'user' | 'assistant';
    time: { created: number };
    finish?: string;
    error?: unknown;
  }>,
  partsByMessageId: {} as Record<string, Array<{ id: string; type: string; text?: string }>>,
  pendingSendMessageIDs: new Map<string, string>(),
}));

vi.mock('@/sync/session-ui-store', () => {
  const state = {
    currentSessionId: 'session-1',
    currentSessionDirectory: '/repo',
    get pendingSendMessageIDs() {
      return mocks.pendingSendMessageIDs;
    },
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
  useSessionParts: (messageId: string) => mocks.partsByMessageId[messageId] ?? [],
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
  mocks.partsByMessageId = {};
  mocks.pendingSendMessageIDs = new Map();
  document.body.innerHTML = '';
});

describe('useAssistantStatus turn settle', () => {
  const renderWorking = async () => {
    let snapshot: ReturnType<typeof useAssistantStatus>['working'] | undefined;
    const Probe = () => {
      snapshot = useAssistantStatus('session-1', '/repo').working;
      return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(snapshot).toBeDefined();
    await act(async () => {
      root.unmount();
    });
    return snapshot!;
  };

  test('confirmed final body hides the working hint while session status is still busy', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 }, finish: 'stop' },
    ];
    mocks.partsByMessageId = {
      'assistant-1': [{ id: 'text-1', type: 'text', text: 'the answer' }],
    };

    const working = await renderWorking();
    expect(working.isTurnSettled).toBe(true);
    expect(working.isWorking).toBe(false);
    expect(working.statusText).toBeNull();
  });

  test('a live last assistant without a confirmed final body keeps the working hint', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 } },
    ];
    mocks.partsByMessageId = {
      'assistant-1': [{ id: 'text-1', type: 'text', text: 'drafting' }],
    };

    const working = await renderWorking();
    expect(working.isTurnSettled).toBe(false);
    expect(working.isWorking).toBe(true);
    expect(working.statusText).toBe('chat.assistantStatus.composing');
  });

  test('pending send starts a new turn even when the previous assistant is settled', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 }, finish: 'stop' },
    ];
    mocks.partsByMessageId = {
      'assistant-1': [{ id: 'text-1', type: 'text', text: 'the answer' }],
    };
    mocks.pendingSendMessageIDs.set('session-1', 'user-2');

    const working = await renderWorking();
    expect(working.isTurnSettled).toBe(false);
    expect(working.isWorking).toBe(true);
    expect(working.statusText).toBe('chat.assistantStatus.sendingMessage');
  });
});
