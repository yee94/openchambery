import { describe, expect, test } from 'vitest';

import {
  LYNX_CHAT_LIST_ENGINE,
  LYNX_FORBIDDEN_CHAT_LIST_ENGINE,
  LYNX_LOAD_OLDER_TRIGGER,
  LYNX_RECYCLE_ITEMS,
  assertLegendListEngine,
  resolveLynxTimelineListFlags,
} from './listSemantics';
import {
  LYNX_FORBID_BOUNCE_INFINITE_LOAD,
  canAcceptLynxLoadOlderTap,
  resolveLynxLoadOlderBusy,
  resolveLynxLoadOlderVisibility,
  shouldIgnoreScrollLoadOlder,
} from './loadOlder';

describe('LegendList 1.19 list semantics', () => {
  test('commits to legendlist and forbids TanStack 1.18', () => {
    expect(LYNX_CHAT_LIST_ENGINE).toBe('legendlist-1.19');
    expect(LYNX_FORBIDDEN_CHAT_LIST_ENGINE).toBe('tanstack-virtual-1.18');
    expect(LYNX_RECYCLE_ITEMS).toBe(false);
    expect(LYNX_LOAD_OLDER_TRIGGER).toBe('button');
    expect(() => assertLegendListEngine('tanstack-virtual-1.18')).toThrow(/forbidden/i);
  });

  test('follow flags match Cap TimelineList while history anchor owns scroll', () => {
    const following = resolveLynxTimelineListFlags({
      followEnabled: true,
      historyAnchorActive: false,
      sessionIsWorking: true,
      endSettledOnce: true,
      prependSettling: false,
    });
    expect(following.maintainScrollAtEnd).toEqual({
      animated: true,
      on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
    });
    expect(following.recycleItems).toBe(false);
    expect(following.listIsScrollView).toBe(true);

    const anchored = resolveLynxTimelineListFlags({
      followEnabled: true,
      historyAnchorActive: true,
      sessionIsWorking: true,
      endSettledOnce: true,
      prependSettling: true,
      knownKeys: new Set(['msg_1']),
    });
    expect(anchored.maintainScrollAtEnd).toBe(false);
    expect(anchored.maintainVisibleContentPosition.shouldRestorePosition?.({ key: 'msg_1' })).toBe(true);
    expect(anchored.maintainVisibleContentPosition.shouldRestorePosition?.({ key: 'new' })).toBe(false);
  });

  test('mobile load-older is button-only (no bounce infinite)', () => {
    expect(LYNX_FORBID_BOUNCE_INFINITE_LOAD).toBe(true);
    expect(shouldIgnoreScrollLoadOlder('bounce')).toBe(true)
    expect(canAcceptLynxLoadOlderTap({ canLoadEarlier: true, isLoadingOlder: false, prependSettling: true })).toBe(false);
    expect(shouldIgnoreScrollLoadOlder('scroll-top')).toBe(true);
    expect(shouldIgnoreScrollLoadOlder('button')).toBe(false);
    expect(resolveLynxLoadOlderVisibility({ canLoadEarlier: false, isLoadingOlder: false })).toBe(false);
    expect(resolveLynxLoadOlderVisibility({ canLoadEarlier: true, isLoadingOlder: false })).toBe(true);
    expect(resolveLynxLoadOlderVisibility({ canLoadEarlier: false, isLoadingOlder: true })).toBe(true);
    expect(resolveLynxLoadOlderBusy({ isLoadingOlder: true })).toBe(true);
  });
});
