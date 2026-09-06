import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import MessageList from './MessageList';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

type ReplayFrame = 'pending' | 'empty' | 'streaming' | 'idle' | 'completed';

class FixtureErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }

  render() {
    if (this.state.error) return <pre data-fixture-error>{this.state.error}</pre>;
    return this.props.children;
  }
}

const sessionID = 'chrome-pending-header';
const nodeIds = new WeakMap<Element, number>();
let nextNodeId = 1;

const nodeId = (node: Element) => {
  const current = nodeIds.get(node);
  if (current) return current;
  const created = nextNodeId;
  nextNodeId += 1;
  nodeIds.set(node, created);
  return created;
};

const userMessage = {
  info: {
    id: 'user-1',
    sessionID,
    role: 'user',
    agent: 'orchestrator-with-an-intentionally-long-mobile-identity',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5-with-an-intentionally-long-mobile-model-name',
    time: { created: 1 },
  } as unknown as Message,
  parts: [{
    id: 'user-text',
    messageID: 'user-1',
    sessionID,
    type: 'text',
    text: 'Investigate the header continuity',
  } as Part],
};

const assistantMessage = (frame: ReplayFrame) => ({
  info: {
    id: 'assistant-1',
    sessionID,
    parentID: 'user-1',
    role: 'assistant',
    agent: 'reviewer-with-an-equally-long-mobile-identity',
    providerID: 'openai',
    modelID: 'gpt-5-6-with-an-equally-long-mobile-model-name',
    ...(frame === 'completed'
      ? { finish: 'stop', time: { created: 2, completed: 10 } }
      : { time: { created: 2 } }),
  } as Message,
  parts: frame === 'empty' ? [] : [{
    id: 'assistant-text',
    messageID: 'assistant-1',
    sessionID,
    type: 'text',
    text: 'Stable answer body',
  } as Part],
});

const host = document.getElementById('root');
if (!host) throw new Error('pending header Chrome fixture root missing');

const root = createRoot(host);
useUIStore.setState({
  isMobile: window.innerWidth <= 640,
  stickyUserHeader: true,
  chatRenderMode: 'live',
  activityRenderMode: 'summary',
  showTurnChangedFiles: false,
  showReasoningTraces: true,
  showExpandedBashTools: false,
});

const afterPaint = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

const replay = async (label: string, frame: ReplayFrame) => {
  const assistant = frame === 'pending' ? null : assistantMessage(frame);
  flushSync(() => {
    root.render(
      <FixtureErrorBoundary>
        <I18nProvider>
          <MessageList
            sessionKey={sessionID}
            messages={assistant ? [userMessage, assistant] : [userMessage]}
            sessionIsWorking={frame === 'pending' || frame === 'empty' || frame === 'streaming'}
            activeStreamingMessageId={frame === 'empty' || frame === 'streaming' ? 'assistant-1' : null}
            activeStreamingPhase={frame === 'empty' || frame === 'streaming' ? 'streaming' : null}
            isLoadingOlder={false}
            onMessageContentChange={() => undefined}
            getAnimationHandlers={() => ({ onChunk: () => undefined, onComplete: () => undefined })}
            enableSendPark={false}
          />
        </I18nProvider>
      </FixtureErrorBoundary>,
    );
  });
  await afterPaint();

  const user = host.querySelector('[data-message-id="user-1"]');
  const heading = host.querySelector('h3');
  const header = heading?.closest('.mb-1\\.5');
  const column = header?.closest('.chat-message-column');
  const wrapper = column?.parentElement;
  const turn = host.querySelector('[data-turn-id="user-1"]');
  const body = host.querySelector('[data-chrome-message-body="assistant-1"]');
  if (!user || !heading || !header || !wrapper || !turn || (frame !== 'pending' && !body)) {
    throw new Error(`pending header Chrome fixture structure missing user=${Boolean(user)} heading=${Boolean(heading)} header=${Boolean(header)} wrapper=${Boolean(wrapper)} body=${Boolean(body)} turn=${Boolean(turn)} html=${host.innerHTML.slice(0, 1200)}`);
  }
  const rect = (node: Element) => node.getBoundingClientRect();
  return {
    label,
    userTop: rect(user).top,
    userHeight: rect(user).height,
    userNode: nodeId(user),
    headerTop: rect(header).top,
    headerHeight: rect(header).height,
    headerNode: nodeId(header),
    headerWrapperTop: rect(wrapper).top,
    headerWrapperHeight: rect(wrapper).height,
    headerWrapperNode: nodeId(wrapper),
    bodyTop: body ? rect(body).top : null,
    bodyHeight: body ? rect(body).height : null,
    bodyNode: body ? nodeId(body) : null,
    occupiedHeight: rect(turn).height,
    headingText: heading.textContent || '',
  };
};

declare global {
  interface Window {
    pendingHeaderReplay: { replay: typeof replay };
  }
}

window.pendingHeaderReplay = { replay };
