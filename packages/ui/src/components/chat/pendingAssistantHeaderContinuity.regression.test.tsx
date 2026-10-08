import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import MessageList from './MessageList';
import { useNotificationStore } from '@/sync/notification-store';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';

const mocks = vi.hoisted(() => ({
  realBody: false,
  errorAt: undefined as number | undefined,
  uiState: {
    isMobile: false,
    stickyUserHeader: true,
    chatRenderMode: 'live' as 'live' | 'sorted',
    activityRenderMode: 'summary' as const,
    showTurnChangedFiles: false,
    showReasoningTraces: true,
    showAssistantTps: true,
    showExpandedBashTools: false,
    setImagePreviewOpen: () => undefined,
  },
}));

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

vi.mock('@/lib/i18n', () => ({
  getCurrentIntlLocale: () => 'en-US',
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/device', () => ({
  useDeviceInfo: () => ({
    isMobile: mocks.uiState.isMobile,
    isTablet: false,
    hasTouchInput: false,
  }),
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState),
    { getState: () => mocks.uiState },
  ),
}));

vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: { providers: never[] }) => unknown) => selector({ providers: [] }),
}));

vi.mock('@/stores/contextStore', () => ({
  useContextStore: (selector: (state: {
    currentAgentContext: Map<string, string>;
    sessionAgentSelections: Map<string, string>;
  }) => unknown) => selector({
    currentAgentContext: new Map(),
    sessionAgentSelections: new Map(),
  }),
}));

vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: (selector: (state: {
    getAgentModelForSession: () => undefined;
    getSessionModelSelection: () => undefined;
  }) => unknown) => selector({
    getAgentModelForSession: () => undefined,
    getSessionModelSelection: () => undefined,
  }),
}));

vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    currentSessionId: 'session-new',
    revertToMessage: async () => undefined,
    editMessagePreservingChanges: async () => undefined,
    forkFromMessage: async () => undefined,
    messageEditCommitting: null,
    stagedMessageEdit: null,
    clearStagedMessageEdit: () => undefined,
  }),
}));

vi.mock('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: (selector: (state: { reviewTransferBySessionId: Map<string, unknown> }) => unknown) => selector({
    reviewTransferBySessionId: new Map<string, unknown>(),
  }),
}));

vi.mock('@/stores/useFeatureFlagsStore', () => ({
  useFeatureFlagsStore: (selector: (state: { legendTimelineEnabled: boolean }) => unknown) => selector({
    legendTimelineEnabled: false,
  }),
}));

vi.mock('@/components/ui/ModelLogo', () => ({
  ModelLogo: ({ modelId }: { modelId?: string | null }) => React.createElement(
    'span',
    { 'data-testid': 'model-logo', 'data-model-id': modelId ?? '' },
  ),
}));

vi.mock('@/components/chat/AgentAvatar', () => ({
  AgentAvatar: ({ name }: { name: string }) => React.createElement(
    'span',
    { 'data-testid': 'agent-avatar', 'data-agent-name': name },
  ),
}));

vi.mock('@/sync/sync-context', async () => {
  const { createStore } = await import('zustand/vanilla');
  const store = createStore(() => ({ session_execution_recovery: {}, session_status: {} }));
  return {
    useDirectoryStore: () => store,
    useSessionMessages: () => [],
    useDirectorySync: () => false,
    useSessionParts: () => [],
    useSessionErrorAt: () => mocks.errorAt,
  };
});

vi.mock('./message/MessageBody', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./message/MessageBody')>();
  return {
    default: (props: React.ComponentProps<typeof actual.default>) => mocks.realBody
      ? React.createElement(actual.default, props)
      : React.createElement(
        'div',
        { 'data-testid': `message-body-${props.messageId}` },
        props.parts
          .filter((part): part is Part & { text: string } => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(''),
      ),
  };
});

vi.mock('./MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('./message/parts/UserTextPart', () => ({ default: ({ part }: { part: { text: string } }) => <p>{part.text}</p> }));

vi.mock('./hooks/useMarkdownPinReveal', () => ({
  useMarkdownPinReveal: () => false,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionID = 'session-new';

const userMessage = (): { info: Message; parts: Part[] } => ({
  info: {
    id: 'user-1',
    sessionID,
    role: 'user',
    agent: 'build',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    time: { created: 1 },
  } as unknown as Message,
  parts: [{
    id: 'user-text',
    messageID: 'user-1',
    sessionID,
    type: 'text',
    text: 'Investigate the flicker',
  } as Part],
});

const assistantMessage = (input: {
  parts?: Part[];
  completed?: boolean;
} = {}): { info: Message; parts: Part[] } => ({
  info: {
    id: 'assistant-1',
    sessionID,
    parentID: 'user-1',
    role: 'assistant',
    agent: 'orchestrator',
    providerID: 'openai',
    modelID: 'gpt-5.6',
    ...(input.completed ? { finish: 'stop' } : {}),
    time: input.completed ? { created: 2, completed: 10 } : { created: 2 },
  } as Message,
  parts: input.parts ?? [],
});

const textPart = (text: string): Part => ({
  id: 'assistant-text',
  messageID: 'assistant-1',
  sessionID,
  type: 'text',
  text,
} as Part);

const getHeaderRoot = (container: HTMLElement): HTMLElement => {
  const heading = container.querySelector<HTMLElement>('h3');
  if (!heading) throw new Error('expected assistant header');
  let current: HTMLElement | null = heading;
  while (current && !current.classList.contains('mb-1.5')) {
    current = current.parentElement;
  }
  if (!current) throw new Error('expected MessageHeader root');
  return current;
};

const getHeaderLayoutWrapper = (header: HTMLElement): HTMLElement => {
  let column: HTMLElement | null = header.parentElement;
  while (column && !column.classList.contains('chat-message-column')) {
    column = column.parentElement;
  }
  const wrapper = column?.parentElement;
  if (!column || !wrapper) {
    throw new Error('expected assistant header layout wrapper');
  }
  return wrapper;
};

const getTurnLayout = (container: HTMLElement): HTMLElement => {
  const turn = container.querySelector<HTMLElement>('[data-turn-id="user-1"]');
  if (!turn) throw new Error('expected turn layout');
  return turn;
};

describe('new conversation assistant header continuity', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    mocks.realBody = false;
    mocks.errorAt = undefined;
    useNotificationStore.setState({ list: [] });
    mocks.uiState.isMobile = false;
    mocks.uiState.chatRenderMode = 'live';
    mocks.uiState.showReasoningTraces = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const renderFrame = async (input: {
    assistant?: ReturnType<typeof assistantMessage>;
    working: boolean;
    streaming: boolean;
  }) => {
    const messages = input.assistant
      ? [userMessage(), input.assistant]
      : [userMessage()];
    await act(async () => {
      root.render(
        <MessageList
          sessionKey={sessionID}
          messages={messages}
          sessionIsWorking={input.working}
          activeStreamingMessageId={input.streaming ? 'assistant-1' : null}
          activeStreamingPhase={input.streaming ? 'streaming' : null}
          isLoadingOlder={false}
          onMessageContentChange={() => undefined}
          getAnimationHandlers={() => ({
            onChunk: () => undefined,
            onComplete: () => undefined,
          })}
          enableSendPark={false}
        />,
      );
    });
  };

  const renderMessages = async (
    messages: Array<ReturnType<typeof userMessage> | ReturnType<typeof assistantMessage>>,
    working: boolean,
    activeMessageId: string | null = null,
    viewSessionKey: string = sessionID,
  ) => {
    await act(async () => {
      root.render(
        <MessageList
          sessionKey={viewSessionKey}
          messages={messages}
          sessionIsWorking={working}
          activeStreamingMessageId={activeMessageId}
          activeStreamingPhase={null}
          isLoadingOlder={false}
          onMessageContentChange={() => undefined}
          getAnimationHandlers={() => ({
            onChunk: () => undefined,
            onComplete: () => undefined,
          })}
          enableSendPark={false}
        />,
      );
    });
  };

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('keeps turn activity stable through an empty continuation and hidden reasoning (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.realBody = true;
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    mocks.uiState.showReasoningTraces = false;
    const first = assistantMessage({ completed: true, parts: [{
      id: 'bash-1', sessionID, messageID: 'assistant-1', type: 'tool', tool: 'bash', callID: 'call-1',
      state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace\n', title: 'pwd', metadata: {}, time: { start: 2, end: 3 } },
    } as Part] });
    first.info = { ...first.info, finish: 'tool-calls' } as Message;
    await renderMessages([userMessage(), first], true);
    const activityOwner = container.querySelector('[data-message-id="assistant-1"]');
    expect(activityOwner).not.toBeNull();
    const continuation = assistantMessage();
    continuation.info = { ...continuation.info, id: 'assistant-2', time: { created: 11 } };
    for (const parts of [[], [{
      id: 'reasoning-2', sessionID, messageID: 'assistant-2', type: 'reasoning', text: 'Thinking',
    } as Part]]) {
      await renderMessages([userMessage(), first, { ...continuation, parts }], true, 'assistant-2');
      expect(container.querySelector('[data-assistant-content-loading]')).toBeNull();
      expect(container.querySelector('[data-message-id="assistant-2"]')).toBeNull();
      expect(container.querySelector('[data-message-id="assistant-1"]')).toBe(activityOwner);
    }
    const body = { ...textPart('Continuation answer'), id: 'text-2', messageID: 'assistant-2' } as Part;
    await renderMessages([userMessage(), first, { ...continuation, parts: [body] }], true, 'assistant-2');
    expect(container.textContent).toContain('Continuation answer');
    expect(container.querySelector('[data-assistant-content-loading]')).toBeNull();
    expect(container.querySelector('[data-message-id="assistant-1"]')).toBe(activityOwner);
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('retires the restart notice on resumed output and history reload (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.realBody = true;
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const restart = normalizeSessionProjectionMessage(sessionID, {
      id: 'restart-1', type: 'synthetic', time: { created: 3 },
      description: 'Continuing after restart',
      text: 'The server restarted while you were working. Continue from where you left off without repeating completed work.',
    })!;
    const interrupted = assistantMessage({ completed: true });
    interrupted.info.error = { type: 'provider.transport', message: 'Session WebSocket closed' };
    interrupted.info = { ...interrupted.info, time: { created: 2, streamed: 8, completed: 10 }, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } } as Message;
    await renderMessages([userMessage(), interrupted, restart], false);
    expect(container.querySelectorAll('[data-restart-notice]')).toHaveLength(1);
    expect(container.querySelector('[data-restart-notice]')?.textContent).toBe('chat.response.continuingAfterRestart');
    expect(container.querySelector('[data-restart-notice] use')?.getAttribute('href')).toBe('#oc-restart');
    expect(container.querySelector('[data-restart-notice] svg')?.getAttribute('class')).not.toContain('--status-');
    expect(container.textContent).not.toContain('Continue from where you left off');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[data-message-footer]')).toBeNull();
    await renderMessages([userMessage(), interrupted, restart], true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[data-message-footer]')).toBeNull();
    const streaming = assistantMessage({ completed: false, parts: [textPart('continuing')] });
    streaming.info = { ...streaming.info, id: 'assistant-2', time: { created: 4 } };
    await renderMessages([userMessage(), interrupted, restart, { ...streaming, parts: [] }], true, 'assistant-2');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-restart-notice]')).toBeNull();
    expect(container.querySelector('[data-message-footer]')).toBeNull();
    await renderMessages([userMessage(), interrupted, restart, streaming], true);
    expect(container.querySelectorAll('[data-restart-notice]')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const resumed = assistantMessage({ completed: true, parts: [textPart('continued answer')] });
    resumed.info = { ...resumed.info, id: 'assistant-2', time: { created: 4, completed: 5 } };
    await renderMessages([userMessage(), interrupted, restart, resumed], false);
    expect(container.querySelectorAll('[data-restart-notice]')).toHaveLength(0);
    expect(container.textContent).toContain('continued answer');
    expect(container.querySelector('[data-message-footer]')).not.toBeNull();
    expect(container.querySelector('[data-restart-notice] .animate-spin')).toBeNull();
    await renderMessages([], false);
    await renderMessages([userMessage(), interrupted, restart, resumed], false);
    expect(container.querySelectorAll('[data-restart-notice]')).toHaveLength(0);
    const nextRestart = normalizeSessionProjectionMessage(sessionID, {
      id: 'restart-2', type: 'synthetic', time: { created: 6 },
      description: 'Continuing after restart', text: 'Restart instruction',
    })!;
    await renderMessages([userMessage(), interrupted, restart, resumed, nextRestart], false);
    expect(container.querySelectorAll('[data-restart-notice]')).toHaveLength(1);
    expect(container.querySelector('[data-restart-notice]')?.getAttribute('data-message-id')).toBe('restart-2');
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('keeps an opened checkpoint through idle-to-working history/tail handoff (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
      id: 'compact-disclosure', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto',
      summary: 'Summary being read',
    })!;
    const messages = [userMessage(), assistantMessage({ completed: true }), checkpoint];
    await renderMessages(messages, false);
    const toggle = container.querySelector<HTMLButtonElement>('[data-compaction-card] button')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // A new array / refreshed record and loading-related parent render alone
    // must not replace the row or its disclosure state.
    await renderMessages([...messages], false);
    expect(container.querySelector('[data-compaction-card] button')).toBe(toggle);
    await renderMessages(messages, true);
    expect(container.querySelector('[data-compaction-card] button')).toBe(toggle);
    expect(container.querySelector('[data-compaction-card] button')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Summary being read');
    await renderMessages(messages, false);
    expect(container.querySelector('[data-compaction-card] button')).toBe(toggle);
  });

  test('keeps explicit checkpoint disclosure when its row is temporarily unmounted', async () => {
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
      id: 'compact-remount', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto',
      summary: 'Retained summary',
    })!;
    const messages = [userMessage(), assistantMessage({ completed: true }), checkpoint];
    await renderMessages(messages, false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-compaction-card] button')!.click());
    await renderMessages([], false);
    await renderMessages(messages, false);
    expect(container.querySelector('[data-compaction-card] button')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Retained summary');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-compaction-card] button')!.click());
    await renderMessages([], false);
    await renderMessages(messages, false);
    expect(container.querySelector('[data-compaction-card] button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-compaction-card] button')!.click());
    await renderMessages(messages, false, null, 'other-session');
    expect(container.querySelector('[data-compaction-card] button')?.getAttribute('aria-expanded')).toBe('false');
  });

  test('prepending history does not spend the live-tail budget or move its mounted turns', async () => {
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
      id: 'compact-prepend', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto', summary: 'Open summary',
    })!;
    const first = [userMessage(), assistantMessage({ completed: true }), checkpoint];
    await renderMessages(first, false);
    const secondUser = userMessage();
    secondUser.info = { ...secondUser.info, id: 'user-2', time: { created: 20 } };
    await renderMessages([...first, secondUser], true);
    const toggle = container.querySelector<HTMLButtonElement>('[data-compaction-card] button')!;
    await act(async () => toggle.click());
    const older = Array.from({ length: 13 }, (_, index) => {
      const user = userMessage();
      return { ...user, info: { ...user.info, id: `older-${index}`, time: { created: index - 20 } } };
    });
    await renderMessages([...older, ...first, secondUser], false);
    expect(container.querySelector('[data-compaction-card] button')).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('keeps automatic compaction before the continuing reply (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const before = assistantMessage({ completed: true, parts: [textPart('before checkpoint')] });
    before.info.finish = 'length';
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
      id: 'compact-1', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto',
    })!;
    const running = normalizeSessionProjectionMessage(sessionID, {
      id: 'compact-1', type: 'compaction', time: { created: 3 }, status: 'running', reason: 'auto',
    })!;
    await renderMessages([userMessage(), before, running], true);
    const originalDivider = container.querySelector('[data-compaction-card]');
    const originalTurn = getTurnLayout(container);
    expect(container.querySelector('[data-turn-assistant-activity-expanded]')?.getAttribute('data-turn-assistant-activity-expanded')).toBe('true');
    await renderMessages([userMessage(), before, checkpoint], true);
    expect(container.querySelector('[data-compaction-card]')).toBe(originalDivider);
    expect(container.querySelector('[data-turn-assistant-activity-expanded]')?.getAttribute('data-turn-assistant-activity-expanded')).toBe('true');
    const continuation = assistantMessage({ completed: false, parts: [textPart('after checkpoint')] });
    continuation.info = { ...continuation.info, id: 'assistant-2', time: { created: 4 } };
    await renderMessages([userMessage(), before, checkpoint, continuation], true);
    const divider = container.querySelector('[data-compaction-card]');
    const reply = container.querySelector('[data-message-id="assistant-2"]');
    expect(divider).toBeTruthy();
    expect(reply).toBeTruthy();
    expect(divider!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('[data-compaction-card]')).toHaveLength(1);
    expect(divider).toBe(originalDivider);
    expect(getTurnLayout(container)).toBe(originalTurn);
    const final = { ...continuation, info: { ...continuation.info, finish: 'stop', time: { created: 4, completed: 5 } } };
    await renderMessages([userMessage(), before, checkpoint, final], false);
    expect(container.querySelector('[data-compaction-card]')).toBe(originalDivider);
    await renderMessages([], false);
    await renderMessages([userMessage(), before, checkpoint, final], false);
    const reloadedDivider = container.querySelector('[data-compaction-card]');
    const reloadedReply = container.querySelector('[data-message-id="assistant-2"]');
    expect(reloadedDivider!.compareDocumentPosition(reloadedReply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('does not paint historical V2 metadata shells as standalone model headings (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const shells = Array.from({ length: 4 }, (_, index) => {
      const row = assistantMessage({ completed: false });
      return { ...row, info: { ...row.info, id: `shell-${index}`, parentID: undefined, time: { created: index + 1 } } };
    });
    await renderMessages(shells, true);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    await renderMessages(shells, true, 'shell-3');
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.querySelectorAll('[data-message-id="shell-3"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-assistant-content-loading]')).toHaveLength(1);
    expect(container.querySelector('[data-assistant-content-loading]')?.getAttribute('aria-label')).toBe('common.loading');
    const filled = shells.map((row, index) => index === 0 ? { ...row, parts: [textPart('restored body')] } : row);
    await renderMessages(filled, true);
    expect(container.textContent).toContain('restored body');
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    const complete = shells.map((row, index) => ({ ...row, parts: [textPart(`restored ${index}`)] }));
    await renderMessages(complete, true);
    expect(container.querySelectorAll('h3')).toHaveLength(4);
    expect(container.querySelector('[data-assistant-content-loading]')).toBeNull();
    expect(container.querySelectorAll('[data-message-id="shell-3"]')).toHaveLength(1);
    const failed = { ...shells[3], info: { ...shells[3].info, error: { type: 'provider.auth', message: 'Authentication failed' } } };
    await renderMessages([...shells.slice(0, 3), failed], false);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.querySelector('[data-message-id="shell-3"]')).not.toBeNull();
    await renderMessages(shells, false);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('does not paint empty reasoning or hidden content as model-only rows (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const shells = ['', '   ', '\n'].map((text, index) => {
      const row = assistantMessage({ completed: true, parts: [{ ...textPart(text), type: 'reasoning' } as Part] });
      return { ...row, info: { ...row.info, id: `empty-reasoning-${index}`, parentID: undefined } };
    });
    await renderMessages(shells, false);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    const hidden = assistantMessage({ completed: true, parts: [textPart('<system-reminder>internal instruction</system-reminder>')] });
    hidden.info = { ...hidden.info, parentID: undefined };
    await renderMessages([...shells, hidden], false);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    await renderMessages([...shells, { ...hidden, parts: [textPart('Actual answer')] }], false);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.textContent).toContain('Actual answer');
    await renderMessages([...shells, hidden], false);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    expect(container.querySelector('[data-assistant-content-loading]')).toBeNull();
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('paints completed ungrouped content before user history arrives without reopening (mobile=%s, mode=%s)', async (mobile, mode) => {
    mocks.realBody = true;
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    const reply = assistantMessage({ completed: true, parts: [textPart('Completed reply remains visible')] });
    reply.info = { ...reply.info, parentID: undefined };
    await renderMessages([{ ...reply, parts: [] }], false);
    await renderMessages([reply], false);
    expect(container.textContent).toContain('Completed reply remains visible');
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    await renderMessages([userMessage(), reply], false);
    expect(container.textContent).toContain('Investigate the flicker');
    expect(container.textContent).toContain('Completed reply remains visible');
    expect(container.querySelectorAll('h3')).toHaveLength(1);
  });

  test.each(['live', 'sorted'] as const)('renders an execution failure inside its turn below the model header (%s)', async (mode) => {
    mocks.uiState.chatRenderMode = mode;
    mocks.errorAt = 100;
    useNotificationStore.getState().append({ type: 'error', session: sessionID, time: Date.now(), viewed: true,
      error: { name: 'provider', message: 'xAI request failed (400): invalid_grant' } });
    await renderFrame({ working: false, streaming: false });
    const turn = getTurnLayout(container);
    const error = turn.querySelector('[role="alert"]');
    const header = turn.querySelector('h3');
    expect(error?.textContent).toContain('invalid_grant');
    expect(header).toBeTruthy();
    expect(header!.compareDocumentPosition(error!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(turn.querySelectorAll('h3')).toHaveLength(1);
    expect(error?.closest('.chat-message-column')).toBeTruthy();
    mocks.errorAt = undefined;
    await renderFrame({ working: true, streaming: false });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('a tail assistant inline error keeps sole ownership of error presentation', async () => {
    mocks.errorAt = 100;
    useNotificationStore.getState().append({ type: 'error', session: sessionID, time: Date.now(), viewed: true,
      error: { name: 'provider', message: 'failure' } });
    const assistant = assistantMessage({ completed: true });
    assistant.info.error = { type: 'provider', message: 'failure' };
    await renderFrame({ assistant, working: false, streaming: false });
    expect(container.querySelector('[data-session-error]')).toBeNull();
  });

  test.each([
    [false, 'live'], [true, 'live'], [false, 'sorted'], [true, 'sorted'],
  ] as const)('keeps native shell turns neutral (mobile=%s, mode=%s), then restores ordinary headers', async (mobile, mode) => {
    mocks.uiState.isMobile = mobile;
    mocks.uiState.chatRenderMode = mode;
    for (const status of ['pending', 'running', 'completed', 'error']) {
      const shell = userMessage();
      shell.parts = [{ ...shell.parts[0], text: '/shell', shellAction: { command: 'pwd', output: '/workspace\n', status } } as Part];
      await renderMessages([shell], status === 'pending' || status === 'running');
      expect(container.querySelector('h3')).toBeNull();
      expect(container.querySelector('[data-user-message-bubble]')).toBeNull();
      const result = container.querySelector('[data-shell-result]');
      expect(result).toBeTruthy();
      expect(result?.parentElement?.classList.contains('w-full')).toBe(true);
      expect(result?.closest('.sticky')).toBeNull();
    }
    const shellWithMetadata = userMessage();
    shellWithMetadata.parts = [{ ...shellWithMetadata.parts[0], shellAction: { command: 'pwd', status: 'completed' } } as Part];
    await renderMessages([shellWithMetadata, assistantMessage({ completed: true })], false);
    expect(container.querySelector('h3')).toBeNull();
    await renderMessages([userMessage()], true);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.querySelector('[data-user-message-bubble]')).toBeTruthy();
  });

  test('hides the shell marker pending header and completed bridge header while preserving ordinary bash tools', async () => {
    const shell = userMessage();
    shell.parts = [{ ...shell.parts[0], text: 'The following tool was executed by the user', synthetic: true } as Part];
    await renderMessages([shell], true);
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('[data-user-message-bubble]')).toBeNull();
    const bash = assistantMessage({ completed: true, parts: [{
      id: 'bash-1', sessionID, messageID: 'assistant-1', type: 'tool', tool: 'bash', callID: 'call-1',
      state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace\n', title: 'pwd', metadata: {}, time: { start: 2, end: 3 } },
    } as Part] });
    await renderMessages([shell, bash], false);
    expect(container.querySelector('h3')).toBeNull();
    expect(container.querySelector('[data-shell-result]')).toBeTruthy();
    expect(container.querySelector('[data-message-id="assistant-1"]')).toBeNull();
    await renderMessages([userMessage(), bash], false);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.querySelector('[data-message-id="assistant-1"]')).toBeTruthy();
    expect(container.querySelector('[data-user-message-bubble]')).toBeTruthy();
  });

  test('keeps the painted user row and one header shell through metadata, streaming, status flaps, and completion', async () => {
    await renderFrame({ working: true, streaming: false });

    const userRow = container.querySelector<HTMLElement>('[data-message-id="user-1"]');
    expect(userRow).toBeTruthy();
    const header = getHeaderRoot(container);
    const headerWrapper = getHeaderLayoutWrapper(header);
    const turnLayout = getTurnLayout(container);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(header.textContent).toContain('Claude Sonnet 4.5');
    expect(headerWrapper.classList.contains('pt-6')).toBe(true);
    expect(headerWrapper.classList.contains('pb-0')).toBe(true);
    expect(turnLayout.classList.contains('pb-1')).toBe(true);

    await renderFrame({
      assistant: assistantMessage(),
      working: true,
      streaming: true,
    });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(headerWrapper);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(header.textContent).toContain('GPT-5.6');

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')] }),
      working: true,
      streaming: true,
    });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(headerWrapper);

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')] }),
      working: false,
      streaming: false,
    });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(headerWrapper);
    expect(headerWrapper.classList.contains('pb-0')).toBe(true);

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')] }),
      working: true,
      streaming: true,
    });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(headerWrapper);

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')], completed: true }),
      working: false,
      streaming: false,
    });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(container.querySelector('[data-testid="message-body-assistant-1"]')?.textContent)
      .toBe('Streaming');
    expect(getTurnLayout(container)).toBe(turnLayout);
    expect(turnLayout.classList.contains('pb-1')).toBe(true);
    expect(container.querySelector('[data-message-id="assistant-1"]')?.classList.contains('pb-0')).toBe(true);
  });

  test('keeps the in-progress assistant wrapper padding stable through busy to idle to busy', async () => {
    await renderFrame({
      assistant: assistantMessage(),
      working: true,
      streaming: true,
    });
    const header = getHeaderRoot(container);
    const wrapper = getHeaderLayoutWrapper(header);
    expect(wrapper.classList.contains('pt-6')).toBe(true);
    expect(wrapper.classList.contains('pb-0')).toBe(true);

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')] }),
      working: false,
      streaming: false,
    });
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(wrapper);
    expect(wrapper.classList.contains('pt-6')).toBe(true);
    expect(wrapper.classList.contains('pb-0')).toBe(true);

    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Streaming')] }),
      working: true,
      streaming: true,
    });
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(wrapper);
    expect(wrapper.classList.contains('pb-0')).toBe(true);
  });

  test('keeps the pending header shell and compact gap when busy turns idle before any assistant arrives', async () => {
    await renderFrame({ working: true, streaming: false });
    const userRow = container.querySelector<HTMLElement>('[data-message-id="user-1"]');
    const header = getHeaderRoot(container);
    const wrapper = getHeaderLayoutWrapper(header);
    const turnLayout = getTurnLayout(container);
    expect(wrapper.classList.contains('pb-0')).toBe(true);
    expect(turnLayout.classList.contains('pb-1')).toBe(true);

    await renderFrame({ working: false, streaming: false });
    expect(container.querySelector('[data-message-id="user-1"]')).toBe(userRow);
    expect(getHeaderRoot(container)).toBe(header);
    expect(getHeaderLayoutWrapper(getHeaderRoot(container))).toBe(wrapper);
    expect(wrapper.classList.contains('pb-0')).toBe(true);
    expect(getTurnLayout(container)).toBe(turnLayout);
    expect(turnLayout.classList.contains('pb-1')).toBe(true);
  });

  test('starts a historical incomplete assistant with ordinary terminal spacing', async () => {
    await renderFrame({
      assistant: assistantMessage({ parts: [textPart('Historical incomplete answer')] }),
      working: false,
      streaming: false,
    });
    const assistantRow = container.querySelector<HTMLElement>('[data-message-id="assistant-1"]');
    expect(assistantRow?.classList.contains('pb-0')).toBe(true);
    expect(getTurnLayout(container).classList.contains('pb-8')).toBe(true);
  });

  test('keeps the full boundary between a completed turn and a queued user turn', async () => {
    const queuedUser = userMessage();
    queuedUser.info = {
      ...queuedUser.info,
      id: 'user-2',
      time: { created: 20 },
    } as Message;
    queuedUser.parts = queuedUser.parts.map((part) => ({
      ...part,
      id: 'user-text-2',
      messageID: 'user-2',
      text: 'Queued follow-up',
    } as Part));

    await renderMessages([
      userMessage(),
      assistantMessage({ parts: [textPart('Completed first answer')], completed: true }),
      queuedUser,
    ], true);

    expect(container.querySelector('[data-turn-id="user-1"]')?.classList.contains('pb-8')).toBe(true);
    expect(container.querySelector('[data-turn-id="user-2"]')?.classList.contains('pb-1')).toBe(true);
  });
});
