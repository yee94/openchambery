import { describe, expect, test } from 'bun:test';

import {
  clampMobileBackProgress,
  MobileBackNavigationCoordinator,
  settleMobileBackSurface,
  type MobileBackHistory,
} from './mobileBackNavigation';
import { resolveMobileSecondaryBackDecision } from './mobileNavigation';

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
});

describe('resolveMobileSecondaryBackDecision', () => {
  const parent = { id: 'ses_parent', directory: '/proj' };

  test('chat with parent navigates to parent and keeps secondary open', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'chat' },
      parentSessionTarget: parent,
    })).toEqual({ action: 'navigateToParent', parent });
  });

  test('chat root closes secondary', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: { kind: 'chat' },
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

  test('closed secondary is a no-op', () => {
    expect(resolveMobileSecondaryBackDecision({
      secondary: null,
      parentSessionTarget: parent,
    })).toEqual({ action: 'none' });
  });
});

test('clampMobileBackProgress keeps native payloads compositor-safe', () => {
  expect(clampMobileBackProgress(-1)).toBe(0);
  expect(clampMobileBackProgress(0.42)).toBe(0.42);
  expect(clampMobileBackProgress(2)).toBe(1);
  expect(clampMobileBackProgress(Number.NaN)).toBe(0);
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
