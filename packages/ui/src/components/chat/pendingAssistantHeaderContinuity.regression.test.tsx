import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import MessageList from './MessageList';

const mocks = vi.hoisted(() => ({
  uiState: {
    isMobile: false,
    stickyUserHeader: true,
    chatRenderMode: 'live' as const,
    activityRenderMode: 'summary' as const,
    showTurnChangedFiles: false,
    showReasoningTraces: true,
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
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/device', () => ({
  useDeviceInfo: () => ({
    isMobile: false,
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

vi.mock('@/sync/sync-context', () => ({
  useSessionParts: () => [],
}));

vi.mock('./message/MessageBody', () => ({
  default: ({ messageId, parts }: { messageId: string; parts: Part[] }) => React.createElement(
    'div',
    { 'data-testid': `message-body-${messageId}` },
    parts
      .filter((part): part is Part & { text: string } => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''),
  ),
}));

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
  ) => {
    await act(async () => {
      root.render(
        <MessageList
          sessionKey={sessionID}
          messages={messages}
          sessionIsWorking={working}
          activeStreamingMessageId={null}
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
