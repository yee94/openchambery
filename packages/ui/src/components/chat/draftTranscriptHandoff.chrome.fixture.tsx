import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { ChatContainer } from './ChatContainer';
import { I18nProvider } from '@/lib/i18n';
import { queryClient } from '@/lib/queryRuntime';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  createPendingUserMessagePresentation,
  useSessionUIStore,
} from '@/sync/session-ui-store';
import { setDraftHandoffSyncFrame } from './draftTranscriptHandoff.chrome.sync.fixture';

type Phase = 'draft' | 'claimed' | 'partless' | 'authoritative-user' | 'assistant';
type ClaimTiming = 'fast' | 'slow';

type PaintSample = {
  phase: Phase;
  frame: number;
  userPresent: boolean;
  userTop: number | null;
  userHeight: number | null;
  userVisibility: string | null;
  headerPresent: boolean;
  headerTop: number | null;
  headerHeight: number | null;
  headerVisibility: string | null;
  scrollerPresent: boolean;
  scrollerTop: number | null;
  scrollerHeight: number | null;
  composerPresent: boolean;
  composerTop: number | null;
  composerHeight: number | null;
  composerVisibility: string | null;
  loadingPlaceholder: boolean;
  pinReveal: string | null;
};

const sessionID = 'session-draft-handoff';
const messageID = 'user-draft-handoff';
const body = 'Keep this first prompt continuously painted';

const draftPending = createPendingUserMessagePresentation({
  messageID,
  sessionID: 'draft:handoff',
  providerID: 'openai',
  modelID: 'gpt-5.6',
  agent: 'orchestrator',
  text: body,
});
const retainedPending = createPendingUserMessagePresentation({
  messageID,
  sessionID,
  providerID: 'openai',
  modelID: 'gpt-5.6',
  agent: 'orchestrator',
  text: body,
});
const userInfo = {
  ...retainedPending.info,
  sessionID,
  time: { created: 1 },
} as Message;
const userPart = {
  id: 'part-user-handoff',
  messageID,
  sessionID,
  type: 'text',
  text: body,
} as Part;
const assistantInfo = {
  id: 'assistant-draft-handoff',
  sessionID,
  parentID: messageID,
  role: 'assistant',
  providerID: 'openai',
  modelID: 'gpt-5.6',
  agent: 'orchestrator',
  time: { created: 2 },
} as Message;
const assistantPart = {
  id: 'part-assistant-handoff',
  messageID: assistantInfo.id,
  sessionID,
  type: 'text',
  text: 'Assistant response',
} as Part;

const host = document.getElementById('root');
if (!host) throw new Error('draft handoff Chrome fixture root missing');

const rectValue = (node: Element | null, field: 'top' | 'height') => (
  node ? node.getBoundingClientRect()[field] : null
);
const visibility = (node: Element | null) => node ? getComputedStyle(node).visibility : null;
const sample = (phase: Phase, frame: number): PaintSample => {
  const user = host.querySelector(`[data-message-id="${messageID}"]`);
  const header = host.querySelector('h3')?.closest('.mb-1\\.5') ?? null;
  const scroller = host.querySelector('[data-scrollbar="chat"]');
  const composer = host.querySelector('[data-handoff-composer="true"]');
  const pinRoot = host.querySelector('[data-markdown-pin-reveal]');
  return {
    phase,
    frame,
    userPresent: Boolean(user),
    userTop: rectValue(user, 'top'),
    userHeight: rectValue(user, 'height'),
    userVisibility: visibility(user),
    headerPresent: Boolean(header),
    headerTop: rectValue(header, 'top'),
    headerHeight: rectValue(header, 'height'),
    headerVisibility: visibility(header),
    scrollerPresent: Boolean(scroller),
    scrollerTop: rectValue(scroller, 'top'),
    scrollerHeight: rectValue(scroller, 'height'),
    composerPresent: Boolean(composer),
    composerTop: rectValue(composer, 'top'),
    composerHeight: rectValue(composer, 'height'),
    composerVisibility: visibility(composer),
    loadingPlaceholder: Boolean(host.querySelector('[data-session-view-loading="true"]')),
    pinReveal: pinRoot?.getAttribute('data-markdown-pin-reveal') ?? null,
  };
};

const frames = (count = 4) => new Promise<void>((resolve) => {
  let remaining = count;
  const tick = () => {
    remaining -= 1;
    if (remaining <= 0) {
      resolve();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const recordTransition = (
  phase: Phase,
  update: () => void,
  count = 4,
) => new Promise<PaintSample[]>((resolve) => {
  const samples: PaintSample[] = [];
  let index = 0;
  const tick = () => {
    samples.push(sample(phase, index));
    index += 1;
    if (index >= count) {
      resolve(samples);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  flushSync(update);
});

useUIStore.setState({
  isMobile: window.innerWidth <= 640,
  stickyUserHeader: true,
  chatRenderMode: 'live',
  activityRenderMode: 'summary',
  showTurnChangedFiles: false,
  showReasoningTraces: true,
  showExpandedBashTools: false,
});
useFeatureFlagsStore.setState({ legendTimelineEnabled: false });
useProjectsStore.setState({
  projects: [{ id: 'fixture-project', path: '/fixture/project', label: 'Fixture' }],
  activeProjectId: 'fixture-project',
});
useConfigStore.setState({ providers: [], currentAgentName: 'orchestrator' });
const root = createRoot(host);

const replay = async (claimTiming: ClaimTiming) => {
  useSessionUIStore.setState((state) => ({
    currentSessionId: null,
    currentSessionDirectory: '/fixture/project',
    retainedPendingUserMessages: new Map(),
    newSessionDraft: {
      ...state.newSessionDraft,
      open: true,
      draftID: 'draft-handoff',
      draftSubmitting: true,
      draftEstablishing: false,
      pendingUserMessage: draftPending,
    },
  }));
  setDraftHandoffSyncFrame({
    messages: [],
    status: { type: 'idle' },
    renderable: false,
    p0Satisfied: false,
    prefetchStatus: 'loading',
    syncLoading: true,
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ChatContainer autoOpenDraft={false} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });

  const allSamples: PaintSample[] = [sample('draft', 0)];
  if (claimTiming === 'slow') await frames(12);

  allSamples.push(...await recordTransition('claimed', () => {
    setDraftHandoffSyncFrame({
      messages: [],
      status: { type: 'busy' },
      renderable: false,
      p0Satisfied: false,
      prefetchStatus: 'loading',
      syncLoading: true,
    });
    useSessionUIStore.setState((state) => ({
      currentSessionId: sessionID,
      currentSessionDirectory: '/fixture/project',
      retainedPendingUserMessages: new Map([[sessionID, [retainedPending]]]),
      newSessionDraft: {
        ...state.newSessionDraft,
        open: false,
        draftSubmitting: false,
        pendingUserMessage: undefined,
      },
    }));
  }));

  allSamples.push(...await recordTransition('partless', () => {
    setDraftHandoffSyncFrame({
      messages: [{ info: userInfo, parts: [] }],
      status: { type: 'busy' },
    });
  }));

  allSamples.push(...await recordTransition('authoritative-user', () => {
    setDraftHandoffSyncFrame({
      messages: [{ info: userInfo, parts: [userPart] }],
      status: { type: 'busy' },
      renderable: true,
      p0Satisfied: true,
      prefetchStatus: 'ready',
      syncLoading: false,
    });
  }));

  allSamples.push(...await recordTransition('assistant', () => {
    setDraftHandoffSyncFrame({
      messages: [
        { info: userInfo, parts: [userPart] },
        { info: assistantInfo, parts: [assistantPart] },
      ],
      status: { type: 'busy' },
    });
  }));

  return allSamples;
};

declare global {
  interface Window {
    draftHandoffReplay: { replay: typeof replay };
  }
}

window.draftHandoffReplay = { replay };
