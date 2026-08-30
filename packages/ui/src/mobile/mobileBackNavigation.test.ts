import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clampMobileBackProgress,
  commitMobileBackRouteWithoutPresentation,
  MobileBackCommitQueue,
  isMobileBackRouteAcknowledged,
  MobileBackNavigationCoordinator,
  resolveMobileBackSettleDuration,
  settleMobileBackSurface,
  type MobileBackHistory,
} from './mobileBackNavigation';
import {
  popMobileChatRoute,
  pushMobileChatRoute,
  reconcileMobileChatPredecessor,
  replaceMobileChatRoute,
  resolveMobileSecondaryBackDecision,
  type MobileChatRoute,
} from './mobileNavigation';
import {
  acknowledgeMobileSessionMirror,
  expectMobileSessionMirror,
  resetMobileSessionMirror,
} from './useMobileNavigationStore';

const here = dirname(fileURLToPath(import.meta.url));

const route = (id: string, onBack: () => boolean | void, layer: 'root' | 'overlay' = 'root') => ({
  id,
  layer,
  onBack,
  getSurface: () => null,
  getUnderlay: () => null,
});

const historyHarness = () => {
  const entries: Array<Record<string, unknown> | null> = [null];
  let listener: ((state: Record<string, unknown> | null) => void) | null = null;
  const history: MobileBackHistory = {
    currentState: () => entries.at(-1) ?? null,
    pushState: (state) => entries.push(state),
    back: () => {
      if (entries.length > 1) entries.pop();
      listener?.(entries.at(-1) ?? null);
    },
    subscribe: (nextListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
  };
  return { entries, history };
};

describe('MobileBackNavigationCoordinator', () => {
  test('always dispatches to the newest active route and preserves the layer gate', () => {
    const calls: string[] = [];
    const coordinator = new MobileBackNavigationCoordinator(null);
    const removeRoot = coordinator.register(route('chat', () => {
      calls.push('chat');
    }));
    const removeOverlay = coordinator.register(route('diff', () => {
      calls.push('diff');
    }, 'overlay'));

    expect(coordinator.backImmediately('root')).toBe(false);
    expect(coordinator.backImmediately('overlay')).toBe(true);
    expect(calls).toEqual(['diff']);

    removeOverlay();
    expect(coordinator.backImmediately('root')).toBe(true);
    expect(calls).toEqual(['diff', 'chat']);
    removeRoot();
    expect(coordinator.getTopRoute()).toBeNull();
  });

  test('routes programmatic back through the animation driver before committing', () => {
    const calls: string[] = [];
    const coordinator = new MobileBackNavigationCoordinator(null);
    coordinator.register(route('chat', () => {
      calls.push('commit');
    }));
    const clear = coordinator.setAnimatedBackDriver((activeRoute) => {
      calls.push(`animate:${activeRoute.id}`);
      return true;
    });

    expect(coordinator.requestAnimatedBack('root')).toBe(true);
    expect(calls).toEqual(['animate:chat']);
    clear();
    expect(coordinator.requestAnimatedBack('root')).toBe(true);
    expect(calls).toEqual(['animate:chat', 'commit']);
  });

  test('falls back exactly once when the animation driver declines an invoke-only route', () => {
    let commits = 0;
    const coordinator = new MobileBackNavigationCoordinator(null);
    coordinator.register(route('chat', () => {
      commits += 1;
    }));
    coordinator.setAnimatedBackDriver(() => false);

    expect(coordinator.requestAnimatedBack('root')).toBe(true);
    expect(commits).toBe(1);
  });

  test('invoke-only commit without a surface is taken exactly once', () => {
    let commits = 0;
    const invokeRoute = route('chat', () => {
      commits += 1;
    });
    expect(commitMobileBackRouteWithoutPresentation(invokeRoute, true)).toBe(true);
    expect(commits).toBe(1);
  });

  test('invoke-only commit reports a declined route', () => {
    let commits = 0;
    const invokeRoute = route('chat', () => {
      commits += 1;
      return false;
    });
    expect(commitMobileBackRouteWithoutPresentation(invokeRoute, true)).toBe(false);
    expect(commits).toBe(1);
  });

  test('mirrors one push route into H5 history and consumes browser back', () => {
    const harness = historyHarness();
    let calls = 0;
    const coordinator = new MobileBackNavigationCoordinator(harness.history);
    const remove = coordinator.register(route('settings-detail', () => {
      calls += 1;
    }));

    expect(harness.entries).toHaveLength(2);
    harness.history.back();
    expect(calls).toBe(1);

    remove();
    expect(harness.entries).toHaveLength(1);
  });

  test('ignores nested history entries that retain the current route marker', () => {
    const harness = historyHarness();
    let calls = 0;
    const coordinator = new MobileBackNavigationCoordinator(harness.history);
    const remove = coordinator.register(route('settings-detail', () => {
      calls += 1;
    }));
    const current = harness.history.currentState() ?? {};
    harness.history.pushState({ ...current, nested: true });

    harness.history.back();
    expect(calls).toBe(0);
    remove();
  });

  test('unregister cleanup history.back does not dispatch the underlay route', async () => {
    // Overlay routes (image-preview) push H5 history; React Strict Mode or a
    // remount unregisters them with history.back(). That pop must not call the
    // chat secondary / underlay onBack (which would exit the whole session).
    const harness = historyHarness();
    const calls: string[] = [];
    const coordinator = new MobileBackNavigationCoordinator(harness.history);
    const removeRoot = coordinator.register(route('chat', () => {
      calls.push('chat');
    }));
    const removeOverlay = coordinator.register(route('image-preview', () => {
      calls.push('image-preview');
    }, 'overlay'));

    expect(harness.entries).toHaveLength(3);
    removeOverlay();
    await Promise.resolve();
    expect(harness.entries).toHaveLength(2);
    expect(calls).toEqual([]);

    harness.history.back();
    expect(calls).toEqual(['chat']);
    removeRoot();
  });

  test('Strict Mode cleanup+remount of the same id reuses history and never pops the underlay', async () => {
    const harness = historyHarness();
    const calls: string[] = [];
    const coordinator = new MobileBackNavigationCoordinator(harness.history);
    coordinator.register(route('chat', () => {
      calls.push('chat');
    }));

    const first = coordinator.register(route('image-preview', () => {
      calls.push('image-preview-1');
    }, 'overlay'));
    expect(harness.entries).toHaveLength(3);

    // Simulate React Strict Mode: cleanup then re-register same id in one turn.
    first();
    const second = coordinator.register(route('image-preview', () => {
      calls.push('image-preview-2');
    }, 'overlay'));
    await Promise.resolve();

    // One history entry for the overlay, underlay never invoked.
    expect(harness.entries).toHaveLength(3);
    expect(calls).toEqual([]);
    expect(coordinator.getTopRoute()?.id).toBe('image-preview');

    // Real browser back still closes the overlay only.
    harness.history.back();
    expect(calls).toEqual(['image-preview-2']);
    second();
    await Promise.resolve();
  });
});

test('settling commits queue and drain one pop at a time', () => {
  const queue = new MobileBackCommitQueue();
  queue.enqueue();
  queue.enqueue();
  expect(queue.take()).toBe(true);
  expect(queue.take()).toBe(true);
  expect(queue.take()).toBe(false);
  queue.enqueue();
  queue.clear();
  expect(queue.take()).toBe(false);
});

test('pop cleanup waits for route or surface acknowledgment', () => {
  const outgoing = {} as HTMLElement;
  expect(isMobileBackRouteAcknowledged({
    surfaceConnected: true,
    routeToken: 2,
    topRouteToken: 2,
    routeSurface: outgoing,
    outgoingSurface: outgoing,
  })).toBe(false);
  expect(isMobileBackRouteAcknowledged({
    surfaceConnected: true,
    routeToken: 2,
    topRouteToken: 1,
    routeSurface: outgoing,
    outgoingSurface: outgoing,
  })).toBe(true);
  expect(isMobileBackRouteAcknowledged({
    surfaceConnected: false,
    routeToken: 2,
    topRouteToken: 2,
    routeSurface: outgoing,
    outgoingSurface: outgoing,
  })).toBe(true);
});

describe('mobile session mirror acknowledgment', () => {
  test('confirms the newest push/pop target in the same tick', () => {
    resetMobileSessionMirror();
    expectMobileSessionMirror({ sessionId: 'child', directory: '/repo' });
    expectMobileSessionMirror({ sessionId: 'parent', directory: '/repo' });
    expect(acknowledgeMobileSessionMirror({ sessionId: 'parent', directory: '/repo' })).toBe('internal');
  });

  test('normalizes directories before confirming an internal mirror', () => {
    resetMobileSessionMirror();
    expectMobileSessionMirror({ sessionId: 'session', directory: 'C:\\repo\\' });
    expect(acknowledgeMobileSessionMirror({ sessionId: 'session', directory: 'c:/repo/' })).toBe('internal');
  });

  test('runtime reset invalidates an expected mirror generation', () => {
    expectMobileSessionMirror({ sessionId: 'old-runtime', directory: '/repo' });
    resetMobileSessionMirror();
    expect(acknowledgeMobileSessionMirror({ sessionId: 'old-runtime', directory: '/repo' })).toBe('external');
  });
});

describe('MobileTabsRoot secondary enter', () => {
  test('does not wire push WAAPI enter animations', async () => {
    const source = await readFile(join(here, 'MobileTabsRoot.tsx'), 'utf8');
    expect(source).not.toContain('MobilePushPresentationController');
    expect(source).not.toContain('pushPresentation.start');
    expect(source).not.toContain('pushPresentationRef');
    expect(source).toContain('secondaryHostRef.current = top');
    expect(source).toContain('secondaryUnderlayRef.current = predecessor');
    expect(source).toContain(
      'const handleSecondaryBack = useEvent(() => topSecondaryPage?.onBack());',
    );
    expect(source).toContain('onBack: handleSecondaryBack,');
  });

  // Short Projects lists must paint the shared page canvas full-height; never
  // leave a plain --background band under the last card.
  test('uses shared page-canvas background token', async () => {
    const source = await readFile(join(here, 'MobileTabsRoot.tsx'), 'utf8');
    const styles = await readFile(join(here, '../styles/mobile.css'), 'utf8');
    expect(source).toContain('bg-[var(--oc-mobile-page-background)]');
    expect(styles).toContain('--oc-mobile-page-background: color-mix(');
    expect(styles).toContain('.oc-mobile-floating-shell.overflow-hidden');
    expect(styles).toContain('background-color: var(--oc-mobile-page-background)');
  });

  test('adopts the native iOS liquid-glass dock and keeps the web bar as fallback', async () => {
    const source = await readFile(join(here, 'MobileTabsRoot.tsx'), 'utf8');
    expect(source).toContain('useNativeIosTabBar');
    expect(source).toContain("nativeTabBarMode === 'web'");
    expect(source).toContain('<MobileTabBar activeTab={selectedTab}');
    expect(source).toContain('nativeIosComposerSession.warm');
  });
});

describe('resolveMobileSecondaryBackDecision', () => {
  const parent = { id: 'ses_parent', directory: '/proj' };
  const parentRoute = { key: 'parent', sessionId: parent.id, directory: parent.directory };
  const childRoute = { key: 'child', sessionId: 'ses_child', directory: '/proj' };

  test('chat with parent navigates to parent and keeps secondary open', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'chat', routes: [parentRoute, childRoute] },
      parentSessionTarget: parent,
    })).toEqual({ action: 'popChatSession', parent });
  });

  test('chat root closes secondary', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'chat', routes: [parentRoute] },
      parentSessionTarget: null,
    })).toEqual({ action: 'closeSecondary' });
  });

  test('draft closes secondary even when a parent target is present', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'draft' },
      parentSessionTarget: parent,
    })).toEqual({ action: 'closeSecondary' });
  });

  test('assistant closes secondary', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'assistant' },
      parentSessionTarget: null,
    })).toEqual({ action: 'closeSecondary' });
  });

  test('instance management closes secondary', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'instances' },
      parentSessionTarget: null,
    })).toEqual({ action: 'closeSecondary' });
  });

  test('closed secondary is a no-op', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: null,
      parentSessionTarget: parent,
    })).toEqual({ action: 'none' });
  });
});

describe('mobile chat route stack', () => {
  const route = (sessionId: string): MobileChatRoute => ({
    key: sessionId,
    sessionId,
    directory: '/proj',
  });

  test('pushes and pops arbitrary parent-child depth one route at a time', () => {
    const parent = route('parent');
    const child = route('child');
    const grandchild = route('grandchild');
    const stack = pushMobileChatRoute(pushMobileChatRoute([parent], child), grandchild);

    expect(stack.map((entry) => entry.sessionId)).toEqual(['parent', 'child', 'grandchild']);
    expect(popMobileChatRoute(stack).map((entry) => entry.sessionId)).toEqual(['parent', 'child']);
    expect(popMobileChatRoute(popMobileChatRoute(stack)).map((entry) => entry.sessionId)).toEqual(['parent']);
  });

  test('reconciles an immediate predecessor for a deep-linked child', () => {
    const child = route('child');
    const parent = route('parent');
    expect(reconcileMobileChatPredecessor([child], parent)).toEqual([parent, child]);
  });

  test('deduplicates repeated pushes and truncates to an existing ancestor', () => {
    const parent = route('parent');
    const child = route('child');
    const grandchild = route('grandchild');
    expect(pushMobileChatRoute([parent, child], child)).toEqual([parent, child]);
    expect(pushMobileChatRoute([parent, child, grandchild], parent)).toEqual([parent]);
  });

  test('external session replacement collapses nested depth and preserves the page identity', () => {
    const parent = route('parent');
    const child = route('child');
    const external = { ...route('external'), key: 'fresh-key' };
    expect(replaceMobileChatRoute([parent, child], external)).toEqual([
      { ...external, key: child.key },
    ]);
  });
});

test('clampMobileBackProgress keeps native payloads compositor-safe', () => {
  expect(clampMobileBackProgress(-1)).toBe(0);
  expect(clampMobileBackProgress(0.42)).toBe(0.42);
  expect(clampMobileBackProgress(2)).toBe(1);
  expect(clampMobileBackProgress(Number.NaN)).toBe(0);
});

test('settlement duration follows remaining distance and release velocity within bounds', () => {
  const longCommit = resolveMobileBackSettleDuration({ progress: 0.1, commit: true, velocityX: 0 });
  const shortCommit = resolveMobileBackSettleDuration({ progress: 0.8, commit: true, velocityX: 0 });
  const fastCommit = resolveMobileBackSettleDuration({ progress: 0.1, commit: true, velocityX: 2400, viewportWidth: 390 });
  const cancel = resolveMobileBackSettleDuration({ progress: 0.6, commit: false, velocityX: -300 });

  expect(longCommit).toBeGreaterThan(shortCommit);
  expect(fastCommit).toBeLessThan(longCommit);
  expect(longCommit).toBeLessThanOrEqual(320);
  expect(cancel).toBeGreaterThanOrEqual(100);
  expect(cancel).toBeLessThanOrEqual(260);
});

test('settlement cancels its fill-forwards animation before a route reuses the surface', async () => {
  let cancelCalls = 0;
  let receivedKeyframes: Keyframe[] | PropertyIndexedKeyframes | null = null;
  const surface = {
    style: { transform: 'translate3d(42%, 0, 0)' },
    animate: (keyframes: Keyframe[] | PropertyIndexedKeyframes | null) => {
      receivedKeyframes = keyframes;
      return {
        finished: Promise.resolve(),
        cancel: () => {
          cancelCalls += 1;
        },
      };
    },
  } as unknown as HTMLElement;

  await settleMobileBackSurface(surface, true, false);

  expect(cancelCalls).toBe(1);
  expect(surface.style.transform).toBe('translate3d(100%, 0, 0)');
  expect(receivedKeyframes).toEqual([
    { transform: 'translate3d(42%, 0, 0)' },
    { transform: 'translate3d(100%, 0, 0)' },
  ]);
});

test('all three nested transcript entries route through the native phone stack helper', async () => {
    const [messageBody, toolPart] = await Promise.all([
    readFile(join(here, '../components/chat/message/MessageBody.tsx'), 'utf8'),
    readFile(join(here, '../components/chat/message/parts/ToolPart.tsx'), 'utf8'),
  ]);
  expect(messageBody.match(/pushPhoneNestedSession\(/g)).toHaveLength(1);
  expect(toolPart.match(/pushPhoneNestedSession\(/g)).toHaveLength(2);
});
