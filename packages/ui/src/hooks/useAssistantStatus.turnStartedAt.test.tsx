import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  parts: {} as Record<string, Part[]>,
  phase: 'busy' as 'busy' | 'idle',
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
  useDirectorySync: () => false,
  useSessionMessages: () => mocks.messages,
  useSessionParts: (id: string) => mocks.parts[id] ?? [],
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
  useSessionStatus: () => ({ type: mocks.phase }),
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
  useSessionActivity: () => ({ phase: mocks.phase, isWorking: mocks.phase === 'busy' }),
}));

import { useAssistantStatus } from './useAssistantStatus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.restoreAllMocks();
  mocks.messages = [];
  mocks.parts = {};
  mocks.phase = 'busy';
  document.body.innerHTML = '';
});

describe('useAssistantStatus turn start', () => {
  const setTranscript = (rows: unknown[]) => {
    const records = rows.map(row => normalizeSessionProjectionMessage('session-1', row)!);
    mocks.messages = records.map(row => row.info);
    mocks.parts = Object.fromEntries(records.map(row => [row.info.id, row.parts]));
  };
  const userStartedAt = 1_700_000_000_000;
  const compactionStartedAt = userStartedAt + 1_800_000;
  const previousTurn = [
    { id: 'user', type: 'user', text: 'request', time: { created: userStartedAt } },
    { id: 'answer', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'done' }], time: { created: userStartedAt + 58_000 } },
  ];
  const checkpoint = (reason: 'manual' | 'auto', status = 'running') => ({
    id: 'checkpoint', type: 'compaction', reason, status, time: { created: compactionStartedAt },
  });
  const mountStatus = async () => {
    let snapshot: ReturnType<typeof useAssistantStatus>['working'];
    const Probe = () => { snapshot = useAssistantStatus('session-1', '/repo').working; return null; };
    const root = createRoot(document.createElement('div'));
    const render = async () => { await act(async () => root.render(<Probe />)); return snapshot; };
    await render();
    return { render, unmount: async () => { await act(async () => root.unmount()); } };
  };

  test.each([
    ['manual', 'stop'], ['manual', 'tool-calls'], ['auto', 'tool-calls'], ['auto', 'length'],
  ] as const)('%s compaction after %s uses its own lifecycle and the correct clock', async (reason, finish) => {
    vi.spyOn(Date, 'now').mockReturnValue(compactionStartedAt + 3_000);
    const turn = previousTurn.map(row => row.type === 'assistant' ? { ...row, finish } : row);
    setTranscript([...turn, checkpoint(reason)]);
    const view = await mountStatus();
    try {
      expect(await view.render()).toMatchObject({
        isWorking: true, isTurnSettled: false, isGenericStatus: false,
        statusText: 'chat.assistantStatus.compacting',
        turnStartedAt: reason === 'manual' ? compactionStartedAt : userStartedAt,
      });
      // Status-only updates preserve message metadata, as native SSE does.
      mocks.parts.checkpoint = mocks.parts.checkpoint.map(part => ({ ...part, status: 'completed' }));
      expect(await view.render()).toMatchObject({ isWorking: reason === 'auto', isTurnSettled: reason === 'manual' });
      setTranscript([...turn, checkpoint(reason, 'completed'), {
        id: 'continued', type: 'assistant', content: [{ type: 'text', text: 'continuing' }],
        time: { created: compactionStartedAt + 4_000 },
      }]);
      expect(await view.render()).toMatchObject({
        isWorking: true, statusText: 'chat.assistantStatus.composing', turnStartedAt: userStartedAt,
      });
    } finally { await view.unmount(); }
  });

  test.each(['manual', 'auto'] as const)('%s failed compaction settles even before idle arrives', async reason => {
    setTranscript([...previousTurn, checkpoint(reason, 'failed')]);
    const view = await mountStatus();
    try {
      expect(await view.render()).toMatchObject({ isWorking: false, isTurnSettled: true, statusText: null });
    } finally { await view.unmount(); }
  });

  test.each(['manual', 'auto'] as const)('cached running %s compaction cannot invent live work', async reason => {
    mocks.phase = 'idle';
    setTranscript([...previousTurn, checkpoint(reason)]);
    const view = await mountStatus();
    try { expect(await view.render()).toMatchObject({ isWorking: false, statusText: null }); }
    finally { await view.unmount(); }
  });

  test('a new user request supersedes a completed manual checkpoint', async () => {
    const startedAt = compactionStartedAt + 20_000;
    setTranscript([...previousTurn, checkpoint('manual', 'completed'), {
      id: 'next-user', type: 'user', text: 'next request', time: { created: startedAt },
    }]);
    const view = await mountStatus();
    try { expect(await view.render()).toMatchObject({ isWorking: true, isTurnSettled: false, turnStartedAt: startedAt }); }
    finally { await view.unmount(); }
  });

  test('manual compaction without loaded user history still has its own clock', async () => {
    setTranscript([checkpoint('manual')]);
    const view = await mountStatus();
    try {
      expect(await view.render()).toMatchObject({ isWorking: true, turnStartedAt: compactionStartedAt, statusText: 'chat.assistantStatus.compacting' });
    } finally { await view.unmount(); }
  });

  test('successive manual compactions use the latest checkpoint clock', async () => {
    const startedAt = compactionStartedAt + 60_000;
    setTranscript([...previousTurn, checkpoint('manual', 'completed'), {
      ...checkpoint('manual'), id: 'next-checkpoint', time: { created: startedAt },
    }]);
    const view = await mountStatus();
    try { expect(await view.render()).toMatchObject({ isWorking: true, turnStartedAt: startedAt }); }
    finally { await view.unmount(); }
  });

  test('uses the latest user message server creation timestamp', async () => {
    const serverTurnStartedAt = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(serverTurnStartedAt + 82_000);
    mocks.messages = [
      { id: 'user-older', sessionID: 'session-1', role: 'user', time: { created: serverTurnStartedAt - 30_000 } },
      { id: 'assistant-older', sessionID: 'session-1', role: 'assistant', time: { created: serverTurnStartedAt - 20_000 } },
      { id: 'user-current', sessionID: 'session-1', role: 'user', time: { created: serverTurnStartedAt } },
      { id: 'assistant-current', sessionID: 'session-1', role: 'assistant', time: { created: serverTurnStartedAt + 1_000 } },
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
