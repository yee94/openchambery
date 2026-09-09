import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AssistantDTO } from '@/queries/assistantDTO';

const contactEvents = vi.hoisted(() => ({
  handler: null as ((event: Record<string, unknown>) => void) | null,
}));
const contactQueryState = vi.hoisted(() => ({ extraMessages: 0 }));

vi.mock('@/components/chat/ChatPromptComposer', () => ({
  ChatPromptComposer: () => <div data-test-composer="" />,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (handler: (event: Record<string, unknown>) => void) => {
    contactEvents.handler = handler;
    return () => { contactEvents.handler = null; };
  },
}));
vi.mock('@/apps/MobileShareBridge', () => ({
  donateNativeAssistantInteraction: () => Promise.resolve(),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: false }),
}));
vi.mock('@/queries/assistantQueries', () => ({
  sendAssistantContactMessage: () => Promise.resolve(),
  useAssistantCapabilityQuery: () => ({ data: null }),
  useAssistantContactMessagesQuery: (assistantID: string) => ({
    data: {
      messages: [
        {
          messageID: `${assistantID}:user`,
          assistantID,
          role: 'user',
          turnID: `${assistantID}:turn`,
          bubbleIndex: 0,
          createdAt: 1,
          ordinal: 0,
          status: 'complete',
          fromAssistantID: null,
          fromAssistantName: null,
          parts: [{ type: 'text', text: 'hello' }],
          text: 'hello',
          cards: [],
        },
        ...Array.from({ length: contactQueryState.extraMessages }, (_, index) => ({
          messageID: `${assistantID}:refetch:${index}`,
          assistantID,
          role: 'assistant',
          turnID: `${assistantID}:refetch-turn:${index}`,
          bubbleIndex: 0,
          createdAt: index + 2,
          ordinal: index + 1,
          status: 'complete',
          fromAssistantID: null,
          fromAssistantName: null,
          parts: [{ type: 'text', text: `refetched ${index}` }],
          text: `refetched ${index}`,
          cards: [],
        })),
      ],
      nextCursor: null,
      complete: true,
    },
    isError: false,
    isSuccess: true,
  }),
  useAssistantSnapshotQuery: () => ({ data: { assistants: [] } }),
}));
vi.mock('./assistantPresentation', () => ({
  getAssistantPresentation: (name: string) => ({ displayName: name, avatarEmoji: null }),
}));
vi.mock('./AssistantAssistantCard', () => ({ AssistantAssistantCard: () => null }));
vi.mock('./AssistantScheduleCard', () => ({ AssistantScheduleCard: () => null }));
vi.mock('./AssistantSessionCard', () => ({ AssistantSessionCard: () => null }));
vi.mock('./AssistantWorkingAvatar', () => ({ AssistantWorkingAvatar: () => null }));
vi.mock('./assistantWorking', () => ({
  useAssistantContactWorkingStore: (selector: (state: { setWorking: () => void }) => unknown) => (
    selector({ setWorking: () => undefined })
  ),
}));

import { AssistantConversationSurface } from './AssistantConversationSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assistant = (id: string): AssistantDTO => ({
  id,
  revision: 1,
  enabled: true,
  name: id,
  defaultPrompt: '',
  workspacePath: null,
  effectiveWorkspacePath: '/workspace',
  managedWorkspacePath: null,
  providerID: 'provider',
  modelID: 'model',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: null,
  sessionGeneration: 0,
  historySessionIDs: [],
  historySessionCount: 0,
  assignedSessionIDs: [],
  working: false,
  activeContactTurn: null,
  createdAt: 1,
  updatedAt: 1,
  tombstoneAt: null,
});

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];

const mountSurface = async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ root, host });
  await act(async () => {
    root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />);
  });
  const scroller = host.querySelector<HTMLElement>('[data-assistant-contact-transcript]');
  if (!scroller) throw new Error('contact transcript scroller missing');
  return { root, host, scroller };
};

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
  }
  contactEvents.handler = null;
  contactQueryState.extraMessages = 0;
});

describe('AssistantConversationSurface scroll ownership', () => {
  test('matches primary chat overflow-anchor and overscroll containment', async () => {
    const { scroller } = await mountSurface();
    expect(scroller.style.overflowAnchor).toBe('none');
    expect(scroller.style.overscrollBehavior).toBe('contain');
    expect(scroller.style.overscrollBehaviorY).toBe('contain');
  });

  test('keeps the user reading position while a contact reply streams', async () => {
    const { scroller } = await mountSurface();
    let scrollTop = 120;
    let writes = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 900 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes += 1; },
      },
    });

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    await act(async () => {
      contactEvents.handler?.({
        type: 'contact-bubble-delta',
        assistantID: 'assistant-a',
        turnID: 'assistant-a:turn',
        bubbleIndex: 0,
        delta: 'stream token',
        done: false,
        occurredAt: 2,
      });
    });

    expect(scrollTop).toBe(120);
    expect(writes).toBe(0);
  });

  test('keeps the user reading position when a contact refetch appends a row', async () => {
    const { root, scroller } = await mountSurface();
    let scrollTop = 180;
    let writes = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes += 1; },
      },
    });

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    contactQueryState.extraMessages = 1;
    await act(async () => {
      root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />);
    });

    expect(scrollTop).toBe(180);
    expect(writes).toBe(0);
  });
});
