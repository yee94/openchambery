import React, { act } from 'react';
import type { Message } from '@opencode-ai/sdk/v2';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import TurnAssistantHeader from './TurnAssistantHeader';

const mocks = vi.hoisted(() => ({
  providers: [{
    id: 'assistant-provider',
    models: [{
      id: 'assistant-model',
      name: 'Catalog Display Name',
      variants: { high: {} },
    }],
  }],
  contextAgent: 'context-agent',
  savedAgent: 'saved-agent',
  agentSelection: { providerId: 'agent-provider', modelId: 'agent-model' },
  sessionSelection: { providerId: 'session-provider', modelId: 'session-model' },
}));

vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: { providers: typeof mocks.providers }) => unknown) => selector({
    providers: mocks.providers,
  }),
}));

vi.mock('@/stores/contextStore', () => ({
  useContextStore: (selector: (state: {
    currentAgentContext: Map<string, string>;
    sessionAgentSelections: Map<string, string>;
  }) => unknown) => selector({
    currentAgentContext: new Map([['session-1', mocks.contextAgent]]),
    sessionAgentSelections: new Map([['session-1', mocks.savedAgent]]),
  }),
}));

vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: (selector: (state: {
    getAgentModelForSession: (sessionId: string, agentName: string) => typeof mocks.agentSelection | null;
    getSessionModelSelection: (sessionId: string) => typeof mocks.sessionSelection | null;
  }) => unknown) => selector({
    getAgentModelForSession: (sessionId) => (
      sessionId === 'session-1' ? mocks.agentSelection : null
    ),
    getSessionModelSelection: (sessionId) => (
      sessionId === 'session-1' ? mocks.sessionSelection : null
    ),
  }),
}));

vi.mock('@/components/ui/ModelLogo', () => ({
  ModelLogo: ({ modelId, providerId }: { modelId?: string | null; providerId?: string | null }) => (
    <span data-model-id={modelId ?? ''} data-provider-id={providerId ?? ''} />
  ),
}));

vi.mock('@/components/chat/AgentAvatar', () => ({
  AgentAvatar: ({ name }: { name: string }) => <span data-agent-name={name} />,
}));

const entry = (info: Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>) => ({
  info: info as Message,
  parts: [],
});

const bareUser = (sessionID: string, id = 'user-bare') => entry({
  id,
  sessionID,
  role: 'user',
});

const bareAssistant = (sessionID: string, id: string) => entry({
  id,
  sessionID,
  role: 'assistant',
});

describe('TurnAssistantHeader identity priority', () => {
  test('assistant execution identity wins and catalog display name plus variant remain available', () => {
    const html = renderToStaticMarkup(
      <TurnAssistantHeader
        assistantMessage={entry({
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          mode: 'reviewer-mode',
          agent: 'assistant-agent',
          providerID: 'assistant-provider',
          modelID: 'assistant-model',
        } as Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>)}
        userMessage={entry({
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          agent: 'user-agent',
          providerID: 'user-provider',
          modelID: 'user-model',
          model: { providerID: 'user-provider', modelID: 'user-model', variant: 'high' },
        } as Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>)}
        assistantIsInActiveTurn
        isMobile={false}
      />,
    );

    expect(html).toContain('Catalog Display Name');
    expect(html).toContain('Reviewer-mode');
    expect(html).toContain('High');
    expect(html).toContain('data-model-id="assistant-model"');
    expect(html).toContain('data-provider-id="assistant-provider"');
  });

  test('user identity precedes live context and selection fallbacks', () => {
    const html = renderToStaticMarkup(
      <TurnAssistantHeader
        assistantMessage={entry({ id: 'assistant-2', sessionID: 'session-1', role: 'assistant' })}
        userMessage={entry({
          id: 'user-2',
          sessionID: 'session-1',
          role: 'user',
          mode: 'user-mode',
          providerID: 'user-provider',
          modelID: 'user-model',
        } as Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>)}
        assistantIsInActiveTurn
        isMobile={false}
      />,
    );

    expect(html).toContain('User-mode');
    expect(html).toContain('data-model-id="user-model"');
    expect(html).toContain('data-provider-id="user-provider"');
  });
});

describe('TurnAssistantHeader identity continuity without module cache', () => {
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

  const renderHeader = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
    });
  };

  test('new mount with same assistant id in another session does not leak prior identity', async () => {
    const sharedAssistantId = 'shared-assistant-id';

    await renderHeader(
      <TurnAssistantHeader
        assistantMessage={entry({
          id: sharedAssistantId,
          sessionID: 'session-a',
          role: 'assistant',
          mode: 'leaked-agent',
          providerID: 'assistant-provider',
          modelID: 'assistant-model',
        } as Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>)}
        userMessage={bareUser('session-a', 'user-a')}
        assistantIsInActiveTurn={false}
        isMobile={false}
      />,
    );

    expect(container.innerHTML).toContain('Leaked-agent');
    expect(container.innerHTML).toContain('data-model-id="assistant-model"');
    expect(container.innerHTML).toContain('data-provider-id="assistant-provider"');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await renderHeader(
      <TurnAssistantHeader
        assistantMessage={bareAssistant('session-b', sharedAssistantId)}
        userMessage={bareUser('session-b', 'user-b')}
        assistantIsInActiveTurn={false}
        isMobile={false}
      />,
    );

    expect(container.innerHTML).not.toContain('Leaked-agent');
    expect(container.innerHTML).not.toContain('data-model-id="assistant-model"');
    expect(container.innerHTML).not.toContain('data-provider-id="assistant-provider"');
    expect(container.innerHTML).not.toContain('data-agent-name="leaked-agent"');
  });

  test('same turn keeps known identity when assistant metadata later goes missing', async () => {
    const assistantId = 'sticky-assistant';
    const userMessage = bareUser('session-sticky', 'user-sticky');

    await renderHeader(
      <TurnAssistantHeader
        assistantMessage={entry({
          id: assistantId,
          sessionID: 'session-sticky',
          role: 'assistant',
          mode: 'sticky-agent',
          providerID: 'assistant-provider',
          modelID: 'assistant-model',
        } as Partial<Message> & Pick<Message, 'id' | 'sessionID' | 'role'>)}
        userMessage={userMessage}
        assistantIsInActiveTurn={false}
        isMobile={false}
      />,
    );

    expect(container.innerHTML).toContain('Sticky-agent');
    expect(container.innerHTML).toContain('data-model-id="assistant-model"');
    expect(container.innerHTML).toContain('data-provider-id="assistant-provider"');

    await renderHeader(
      <TurnAssistantHeader
        assistantMessage={bareAssistant('session-sticky', assistantId)}
        userMessage={userMessage}
        assistantIsInActiveTurn={false}
        isMobile={false}
      />,
    );

    expect(container.innerHTML).toContain('Sticky-agent');
    expect(container.innerHTML).toContain('data-model-id="assistant-model"');
    expect(container.innerHTML).toContain('data-provider-id="assistant-provider"');
  });
});
