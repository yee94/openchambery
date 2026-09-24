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
  recovering: false,
  phase: 'busy' as 'busy' | 'retry' | 'idle',
}));

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});

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
  useDirectorySync: (selector: (state: { session_execution_recovery: Record<string, { reason: string }> }) => unknown) => selector({
    session_execution_recovery: mocks.recovering ? { 'session-1': { reason: 'shutdown' } } : {},
  }),
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
  useSessionActivity: () => ({ phase: mocks.phase, isWorking: mocks.phase !== 'idle' }),
}));

import { useAssistantStatus } from './useAssistantStatus';
import { StatusRowContainer } from '@/components/chat/StatusRowContainer';
import { PRIMARY_SESSION_SURFACE, SessionSurfaceContext } from '@/components/chat/SessionSurfaceContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.restoreAllMocks();
  mocks.messages = [];
  mocks.partsByMessageId = {};
  mocks.pendingSendMessageIDs = new Map();
  mocks.recovering = false;
  mocks.phase = 'busy';
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

  test('an interrupted response cannot keep thinking from an unfinished reasoning part', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 }, error: { type: 'aborted', message: 'Step interrupted' } },
    ];
    mocks.partsByMessageId = { 'assistant-1': [{ id: 'reasoning-1', type: 'reasoning', text: 'partial' }] };
    const working = await renderWorking();
    expect(working.isWorking).toBe(false);
    expect(working.isTurnSettled).toBe(true);
    expect(working.statusText).toBeNull();
  });

  test('shutdown recovery suppresses thinking even before the step failure arrives', async () => {
    mocks.recovering = true;
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 } },
    ];
    mocks.partsByMessageId = { 'assistant-1': [{ id: 'reasoning-1', type: 'reasoning', text: 'partial' }] };
    const working = await renderWorking();
    expect(working.isWorking).toBe(false);
    expect(working.statusText).toBeNull();
    expect(working.isRecovering).toBe(true);
    expect(working.isTurnSettled).toBe(false);
    mocks.recovering = false;
    const resumed = await renderWorking();
    expect(resumed.isWorking).toBe(true);
    expect(resumed.statusText).toBe('chat.assistantStatus.thinking');
  });

  test('authoritative retry remains visible after a failed step without claiming to be thinking', async () => {
    mocks.phase = 'retry';
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 }, error: { type: 'provider.transport' } },
    ];
    mocks.partsByMessageId = { 'assistant-1': [{ id: 'reasoning-1', type: 'reasoning', text: 'partial' }] };
    const working = await renderWorking();
    expect(working.isWorking).toBe(true);
    expect(working.retryInfo).not.toBeNull();
    expect(working.statusText).not.toBe('chat.assistantStatus.thinking');
  });

  test('the rendered thinking hint disappears immediately on shutdown and error, and retry/resumed work render distinctly', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 } },
    ];
    mocks.partsByMessageId = { 'assistant-1': [{ id: 'reasoning-1', type: 'reasoning', text: 'partial' }] };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () => act(async () => root.render(
      <SessionSurfaceContext.Provider value={{ ...PRIMARY_SESSION_SURFACE }}>
        <StatusRowContainer />
      </SessionSurfaceContext.Provider>,
    ));
    try {
      await render();
      expect(container.textContent).toContain('chat.assistantStatus.thinking');
      mocks.recovering = true;
      await render();
      expect(container.textContent).toBe('');
      mocks.recovering = false;
      mocks.messages = [mocks.messages[0], { ...mocks.messages[1], error: { type: 'aborted' } }];
      await render();
      expect(container.textContent).toBe('');
      mocks.phase = 'retry';
      await render();
      expect(container.textContent).toContain('chat.assistantStatus.retrying');
      expect(container.textContent).not.toContain('chat.assistantStatus.thinking');
      mocks.phase = 'busy';
      mocks.messages = [...mocks.messages, { id: 'assistant-2', role: 'assistant', time: { created: 3 } }];
      mocks.partsByMessageId['assistant-2'] = [{ id: 'text-2', type: 'text', text: 'resumed' }];
      await render();
      expect(container.textContent).toContain('chat.assistantStatus.composing');
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('a newer user row keeps the working hint after the send request settles', async () => {
    mocks.messages = [
      { id: 'user-1', role: 'user', time: { created: 1 } },
      { id: 'assistant-1', role: 'assistant', time: { created: 2 }, finish: 'stop' },
      { id: 'user-2', role: 'user', time: { created: 3 } },
    ];
    mocks.partsByMessageId = {
      'assistant-1': [{ id: 'text-1', type: 'text', text: 'the answer' }],
    };

    const working = await renderWorking();
    expect(working.isTurnSettled).toBe(false);
    expect(working.isWorking).toBe(true);
    expect(working.statusText).toEqual(expect.any(String));
    expect(working.statusText).not.toBe('chat.assistantStatus.sendingMessage');
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
    expect(working.canAbort).toBe(true);
    expect(working.statusText).toBe('chat.assistantStatus.sendingMessage');
  });
});
