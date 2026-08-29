import { afterEach, describe, expect, test, vi } from 'vitest';

import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';

import {
  attachNativeIosComposerLeaveConceal,
  concealNativeComposerIfLeavingChat,
  didLeaveNativeComposerSurface,
  shouldConcealNativeComposerOnBackStart,
} from './native-ios-composer-leave';

describe('native iOS composer leave conceal', () => {
  afterEach(() => {
    useMobileNavigationStore.getState().reset();
  });

  test('interactive back of the last chat page conceals; nested pops do not', () => {
    expect(shouldConcealNativeComposerOnBackStart(null)).toBe(false);
    expect(shouldConcealNativeComposerOnBackStart({ kind: 'instances' })).toBe(false);
    expect(shouldConcealNativeComposerOnBackStart({ kind: 'draft' })).toBe(true);
    expect(shouldConcealNativeComposerOnBackStart({
      kind: 'chat',
      routes: [{ key: 'chat-primary', sessionId: 's1', directory: null }],
    })).toBe(true);
    expect(shouldConcealNativeComposerOnBackStart({
      kind: 'chat',
      routes: [
        { key: 'chat-primary', sessionId: 'parent', directory: null },
        { key: 'chat-child', sessionId: 'child', directory: null },
      ],
    })).toBe(false);
  });

  test('closing chat or draft to the root tab is a leave', () => {
    expect(didLeaveNativeComposerSurface(
      { kind: 'chat', routes: [{ key: 'chat-primary', sessionId: 's1', directory: null }] },
      null,
    )).toBe(true);
    expect(didLeaveNativeComposerSurface({ kind: 'draft' }, null)).toBe(true);
    expect(didLeaveNativeComposerSurface(
      { kind: 'chat', routes: [{ key: 'chat-primary', sessionId: 's1', directory: null }] },
      { kind: 'chat', routes: [{ key: 'chat-primary', sessionId: 's2', directory: null }] },
    )).toBe(false);
    expect(didLeaveNativeComposerSurface({ kind: 'instances' }, null)).toBe(false);
  });

  test('closing the chat secondary conceals immediately', () => {
    const session = { conceal: vi.fn(), reveal: vi.fn() };
    const detach = attachNativeIosComposerLeaveConceal(session);
    useMobileNavigationStore.setState({
      secondary: {
        kind: 'chat',
        routes: [{ key: 'chat-primary', sessionId: 's1', directory: null }],
      },
    });
    expect(session.conceal).not.toHaveBeenCalled();

    useMobileNavigationStore.setState({ secondary: null });
    expect(session.conceal).toHaveBeenCalledTimes(1);

    detach();
  });

  test('leaving the last chat page conceals before the back animation settles', () => {
    const session = { conceal: vi.fn() };
    useMobileNavigationStore.setState({
      secondary: {
        kind: 'chat',
        routes: [{ key: 'chat-primary', sessionId: 's1', directory: null }],
      },
    });
    concealNativeComposerIfLeavingChat(session);
    expect(session.conceal).toHaveBeenCalledTimes(1);

    useMobileNavigationStore.setState({
      secondary: {
        kind: 'chat',
        routes: [
          { key: 'chat-primary', sessionId: 'parent', directory: null },
          { key: 'chat-child', sessionId: 'child', directory: null },
        ],
      },
    });
    concealNativeComposerIfLeavingChat(session);
    expect(session.conceal).toHaveBeenCalledTimes(1);
  });
});
