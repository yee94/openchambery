import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type EndpointDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
};

const mocks = vi.hoisted(() => {
  const endpointListeners = new Set<(detail: EndpointDetail) => void>();
  return {
    isLocalRuntimeActive: true,
    runtimeKey: 'local',
    switchResult: { ok: true as const } as { ok: true } | { ok: false; reason: string },
    switchCalls: 0,
    setCurrentSession: [] as Array<[string, string | null]>,
    setActiveMainTab: [] as string[],
    notifyFailed: [] as Array<{ sessionId: string | null; reason: string }>,
    endpointListeners,
    unsubscribeSpies: [] as Array<ReturnType<typeof vi.fn>>,
  };
});

vi.mock('@/lib/desktopLocalRuntime', () => ({
  isLocalRuntimeActive: () => mocks.isLocalRuntimeActive,
  switchToLocalDesktopRuntime: async () => {
    mocks.switchCalls += 1;
    return mocks.switchResult;
  },
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => mocks.runtimeKey,
  subscribeRuntimeEndpointChanged: (callback: (detail: EndpointDetail) => void) => {
    mocks.endpointListeners.add(callback);
    const unsubscribe = vi.fn(() => {
      mocks.endpointListeners.delete(callback);
    });
    mocks.unsubscribeSpies.push(unsubscribe);
    return unsubscribe;
  },
}));

vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string, directory: string | null) => {
        mocks.setCurrentSession.push([id, directory]);
      },
    }),
  },
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setActiveMainTab: (tab: string) => {
        mocks.setActiveMainTab.push(tab);
        return true;
      },
    }),
  },
}));

vi.mock('@/sync/openSessionWithFeedback', () => ({
  notifySessionOpenFailed: (sessionId: string | null, reason: string) => {
    mocks.notifyFailed.push({ sessionId, reason });
  },
}));

import {
  disposePendingNotificationOpen,
  openSessionFromNotification,
} from './openSessionFromNotification';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const dispatchEndpoint = (runtimeKey: string): void => {
  const detail: EndpointDetail = {
    apiBaseUrl: 'http://127.0.0.1:4096',
    previousApiBaseUrl: 'http://remote',
    runtimeKey,
    previousRuntimeKey: 'host:remote',
  };
  for (const listener of [...mocks.endpointListeners]) {
    listener(detail);
  }
};

describe('openSessionFromNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.isLocalRuntimeActive = true;
    mocks.runtimeKey = 'local';
    mocks.switchResult = { ok: true };
    mocks.switchCalls = 0;
    mocks.setCurrentSession.length = 0;
    mocks.setActiveMainTab.length = 0;
    mocks.notifyFailed.length = 0;
    mocks.endpointListeners.clear();
    mocks.unsubscribeSpies.length = 0;
  });

  afterEach(() => {
    disposePendingNotificationOpen();
    vi.useRealTimers();
  });

  test('local active opens immediately without switching', () => {
    openSessionFromNotification({ sessionId: 'ses_local', directory: '/repo' });
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.setActiveMainTab).toEqual(['chat']);
    expect(mocks.setCurrentSession).toEqual([['ses_local', '/repo']]);
  });

  test('empty sessionId is a no-op', () => {
    openSessionFromNotification({ sessionId: '  ', directory: '/repo' });
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.setCurrentSession).toEqual([]);
  });

  test('non-local switch success with runtime already local opens immediately', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'local';
    openSessionFromNotification({ sessionId: 'ses_ready', directory: '/repo' });
    await flushMicrotasks();
    expect(mocks.switchCalls).toBe(1);
    expect(mocks.setCurrentSession).toEqual([['ses_ready', '/repo']]);
    expect(mocks.endpointListeners.size).toBe(0);
  });

  test('non-local switch success waits for local endpoint then opens after 100ms', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'host:remote';
    openSessionFromNotification({ sessionId: 'ses_wait', directory: '/repo' });
    await flushMicrotasks();
    expect(mocks.setCurrentSession).toEqual([]);
    expect(mocks.endpointListeners.size).toBe(1);

    dispatchEndpoint('local');
    expect(mocks.setCurrentSession).toEqual([]);
    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.setCurrentSession).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.setActiveMainTab).toEqual(['chat']);
    expect(mocks.setCurrentSession).toEqual([['ses_wait', '/repo']]);
  });

  test('non-local endpoint other than local does not open; 10s timeout fails', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'host:remote';
    openSessionFromNotification({ sessionId: 'ses_timeout', directory: '/repo' });
    await flushMicrotasks();

    dispatchEndpoint('other');
    expect(mocks.setCurrentSession).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.setCurrentSession).toEqual([]);
    expect(mocks.notifyFailed).toEqual([
      { sessionId: 'ses_timeout', reason: 'missing-directory' },
    ]);
  });

  test('switch failure notifies immediately', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'host:remote';
    mocks.switchResult = { ok: false, reason: 'unreachable' };
    openSessionFromNotification({ sessionId: 'ses_fail', directory: '/repo' });
    await flushMicrotasks();
    expect(mocks.setCurrentSession).toEqual([]);
    expect(mocks.notifyFailed).toEqual([
      { sessionId: 'ses_fail', reason: 'missing-directory' },
    ]);
  });

  test('second call while pending clears previous unsubscribe', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'host:remote';
    openSessionFromNotification({ sessionId: 'ses_first', directory: '/a' });
    await flushMicrotasks();
    expect(mocks.unsubscribeSpies).toHaveLength(1);
    const firstUnsubscribe = mocks.unsubscribeSpies[0]!;

    openSessionFromNotification({ sessionId: 'ses_second', directory: '/b' });
    await flushMicrotasks();
    expect(firstUnsubscribe).toHaveBeenCalled();
    expect(mocks.unsubscribeSpies).toHaveLength(2);
    expect(mocks.endpointListeners.size).toBe(1);
  });
});
