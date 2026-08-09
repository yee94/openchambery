import { beforeEach, describe, expect, mock, test } from 'bun:test';

type EffectSlot = {
  cleanup?: () => void;
  deps?: readonly unknown[];
};

const dependenciesChanged = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
  !previous
  || previous.length !== next.length
  || previous.some((dependency, index) => dependency !== next[index]);

const createHookHarness = () => {
  const stateSlots: unknown[] = [];
  const memoSlots: Array<{ value: unknown; deps: readonly unknown[] }> = [];
  const effectSlots: EffectSlot[] = [];
  let hookIndex = 0;
  let mounted = false;
  let renderHook: (() => void) | null = null;

  const react = {
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => {
      const index = hookIndex++;
      const previous = memoSlots[index];
      if (!previous || dependenciesChanged(previous.deps, deps)) {
        memoSlots[index] = { value: callback, deps };
      }
      return memoSlots[index].value as T;
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = hookIndex++;
      const slot = effectSlots[index] ?? {};
      if (dependenciesChanged(slot.deps, deps)) {
        slot.cleanup?.();
        slot.deps = deps;
        effectSlots[index] = slot;
        const cleanup = effect();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => {
      const index = hookIndex++;
      const previous = memoSlots[index];
      if (!previous || dependenciesChanged(previous.deps, deps)) {
        memoSlots[index] = { value: factory(), deps };
      }
      return memoSlots[index].value as T;
    },
    useRef: <T,>(value: T) => {
      const index = hookIndex++;
      if (!(index in stateSlots)) {
        stateSlots[index] = { current: value };
      }
      return stateSlots[index] as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hookIndex++;
      if (!(index in stateSlots)) {
        stateSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setState = (value: T) => {
        stateSlots[index] = value;
        if (mounted) {
          renderHook?.();
        }
      };
      return [stateSlots[index] as T, setState] as const;
    },
  };

  return {
    react,
    reset() {
      effectSlots.forEach((slot) => slot.cleanup?.());
      stateSlots.length = 0;
      memoSlots.length = 0;
      effectSlots.length = 0;
      hookIndex = 0;
      mounted = false;
      renderHook = null;
    },
    render(callback: () => void) {
      renderHook = () => {
        hookIndex = 0;
        callback();
      };
      mounted = true;
      renderHook();
    },
  };
};

const harness = createHookHarness();
const sessionSubscribers = new Set<(state: typeof sessionState) => void>();
const uiSubscribers = new Set<(state: typeof uiState) => void>();
const settingsDialogOpenCalls: boolean[] = [];
const setCurrentSessionCalls: Array<{ sessionId: string; directory: string }> = [];

const sessionState = {
  currentSessionId: 'session-1' as string | null,
  currentSessionDirectory: '/repo' as string | null,
  setCurrentSession: (sessionId: string, directory: string) => {
    setCurrentSessionCalls.push({ sessionId, directory });
    sessionState.currentSessionId = sessionId;
    sessionState.currentSessionDirectory = directory;
  },
};
const uiState = {
  activeMainTab: 'chat' as const,
  isSettingsDialogOpen: false,
  settingsPage: 'home',
  pendingDiffFile: null as string | null,
  setActiveMainTab: () => undefined,
  setSettingsDialogOpen: (isOpen: boolean) => {
    settingsDialogOpenCalls.push(isOpen);
    uiState.isSettingsDialogOpen = isOpen;
  },
  setSettingsPage: (path: string) => {
    uiState.settingsPage = path;
  },
  navigateToDiff: () => undefined,
};
let globalSessionsState = {
  hasLoaded: true,
  activeSessions: [{ id: 'session-1' }],
  archivedSessions: [] as Array<{ id: string }>,
};
let resolvedSessionDirectory = '/repo';
let urlRoute = {
  sessionId: 'session-1' as string | null,
  isNewSession: false,
  tab: null as 'chat' | null,
  settingsPath: null as string | null,
  settingsEntityId: null as string | null,
  diffFile: null as string | null,
  diffScope: null as 'staged' | 'working' | 'turn' | null,
  scheduleView: null as 'tasks' | 'history' | null,
  scheduleProjectId: null as string | null,
  scheduleTaskId: null as string | null,
  assistantId: null as string | null,
  focusSessionId: null as string | null,
};

mock.module('react', () => ({ default: harness.react }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: Object.assign(
    <T,>(selector: (state: typeof sessionState) => T) => selector(sessionState),
    {
      getState: () => sessionState,
      subscribe: (subscriber: (state: typeof sessionState) => void) => {
        sessionSubscribers.add(subscriber);
        return () => sessionSubscribers.delete(subscriber);
      },
    },
  ),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: Object.assign(
    <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
    {
      getState: () => uiState,
      subscribe: (subscriber: (state: typeof uiState) => void) => {
        uiSubscribers.add(subscriber);
        return () => uiSubscribers.delete(subscriber);
      },
    },
  ),
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  resolveGlobalSessionDirectory: () => resolvedSessionDirectory,
  useGlobalSessionsStore: Object.assign(
    <T,>(selector: (state: typeof globalSessionsState) => T) => selector(globalSessionsState),
    { getState: () => globalSessionsState },
  ),
}));
const runtimeEndpointListeners = new Set<(detail: {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
  transportIdentityChanged?: boolean;
}) => void>();

mock.module('@/lib/router', () => ({
  parseRoute: () => ({ ...urlRoute }),
  hasRouteParams: () => true,
  updateBrowserURL: (state: {
    sessionId: string | null;
    isSettingsOpen: boolean;
    settingsPath: string;
  }) => {
    urlRoute = {
      sessionId: state.sessionId,
      isNewSession: Boolean((state as { isNewSession?: boolean }).isNewSession),
      tab: null,
      settingsPath: state.isSettingsOpen ? state.settingsPath : null,
      settingsEntityId: null,
      diffFile: null,
      diffScope: null,
      scheduleView: null,
      scheduleProjectId: null,
      scheduleTaskId: null,
      assistantId: null,
      focusSessionId: null,
    };
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'test-transport',
  getRuntimeGeneration: () => 0,
  getRuntimeKey: () => 'test-runtime',
  isRuntimeEndpointIdentityChange: (detail: { transportIdentityChanged?: boolean }) =>
    detail.transportIdentityChanged !== false,
  subscribeRuntimeEndpointChanged: (
    callback: (detail: {
      apiBaseUrl: string;
      previousApiBaseUrl: string;
      runtimeKey: string;
      previousRuntimeKey: string;
      transportIdentityChanged?: boolean;
    }) => void,
  ) => {
    runtimeEndpointListeners.add(callback);
    return () => runtimeEndpointListeners.delete(callback);
  },
}));
mock.module('@/lib/settings/metadata', () => ({ resolveSettingsSlug: (path: string) => path }));
mock.module('@/components/layout/contextPanelEmbeddedChat', () => ({ isEmbeddedSessionChat: () => false }));
const notifySessionOpenFailedCalls: Array<{ sessionId: string | null; reason: string }> = [];
mock.module('@/sync/openSessionWithFeedback', () => ({
  notifySessionOpenFailed: (sessionId: string | null, reason: string) => {
    notifySessionOpenFailedCalls.push({ sessionId, reason });
  },
  openSessionWithFeedback: () => ({ ok: false, reason: 'missing-directory', sessionId: null }),
}));
mock.module('@/stores/useAssistantUIStore', () => ({
  getSelectedAssistantID: () => null,
  useAssistantUIStore: {
    getState: () => ({ selectAssistant: () => undefined }),
    subscribe: () => () => undefined,
  },
}));
mock.module('@/router/sessionLookup', () => ({
  resolveSessionDirectoryForRoute: (sessionId: string) => {
    const found = [...globalSessionsState.activeSessions, ...globalSessionsState.archivedSessions]
      .some((session) => session.id === sessionId);
    return found ? resolvedSessionDirectory : null;
  },
  resolveSessionForRoute: async (sessionId: string) => {
    const found = [...globalSessionsState.activeSessions, ...globalSessionsState.archivedSessions]
      .find((session) => session.id === sessionId);
    if (!found) return null;
    return {
      sessionId,
      directory: resolvedSessionDirectory,
      session: found,
      fromCache: !globalSessionsState.hasLoaded,
      source: 'memory' as const,
    };
  },
  findSessionById: (sessionId: string) => {
    const found = [...globalSessionsState.activeSessions, ...globalSessionsState.archivedSessions]
      .find((session) => session.id === sessionId);
    if (!found) return null;
    return {
      sessionId,
      directory: resolvedSessionDirectory,
      session: found,
      fromCache: !globalSessionsState.hasLoaded,
      source: 'memory' as const,
    };
  },
}));

const { useRouter } = await import('./useRouter');

describe('useRouter', () => {
  beforeEach(() => {
    harness.reset();
    sessionSubscribers.clear();
    uiSubscribers.clear();
    runtimeEndpointListeners.clear();
    settingsDialogOpenCalls.length = 0;
    setCurrentSessionCalls.length = 0;
    notifySessionOpenFailedCalls.length = 0;
    sessionState.currentSessionId = 'session-1';
    sessionState.currentSessionDirectory = '/repo';
    uiState.activeMainTab = 'chat';
    uiState.isSettingsDialogOpen = false;
    uiState.settingsPage = 'home';
    uiState.pendingDiffFile = null;
    globalSessionsState = {
      hasLoaded: true,
      activeSessions: [{ id: 'session-1' }],
      archivedSessions: [],
    };
    resolvedSessionDirectory = '/repo';
    urlRoute = {
      sessionId: 'session-1',
      isNewSession: false,
      tab: null,
      settingsPath: null,
      settingsEntityId: null,
      diffFile: null,
      diffScope: null,
      scheduleView: null,
      scheduleProjectId: null,
      scheduleTaskId: null,
      assistantId: null,
      focusSessionId: null,
    };
  });

  test('does not close Settings when the current session summary updates', async () => {
    harness.render(useRouter);
    await Promise.resolve();

    settingsDialogOpenCalls.length = 0;
    uiState.setSettingsDialogOpen(true);

    globalSessionsState = {
      ...globalSessionsState,
      activeSessions: [{ id: 'session-1' }],
    };
    harness.render(useRouter);

    expect(uiState.isSettingsDialogOpen).toBe(true);
    expect(settingsDialogOpenCalls).toEqual([true]);
  });

  test('keeps Settings open while the resolved session is absent from a summary refresh', async () => {
    harness.render(useRouter);
    await Promise.resolve();

    uiState.setSettingsDialogOpen(true);
    globalSessionsState = {
      ...globalSessionsState,
      activeSessions: [],
    };
    harness.render(useRouter);

    expect(uiState.isSettingsDialogOpen).toBe(true);
    expect(settingsDialogOpenCalls).toEqual([true]);
  });

  test('skips the deep-link timeout after the session resolves', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let timeoutCalls = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timeoutCalls += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      harness.render(useRouter);
      await Promise.resolve();

      expect(timeoutCalls).toBe(0);
      expect(urlRoute.sessionId).toBe('session-1');
    } finally {
      harness.reset();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('reconciles a selected session to its authoritative directory', async () => {
    sessionState.currentSessionDirectory = '/stale-repo';
    resolvedSessionDirectory = '/repo/worktree';

    harness.render(useRouter);
    await Promise.resolve();

    expect(setCurrentSessionCalls[0]).toEqual({
      sessionId: 'session-1',
      directory: '/repo/worktree',
    });
    expect(sessionState.currentSessionDirectory).toBe('/repo/worktree');
  });

  test('toasts missing-directory only once for a dead deep-link session', async () => {
    sessionState.currentSessionId = null;
    sessionState.currentSessionDirectory = null;
    urlRoute.sessionId = 'ses_dead';
    globalSessionsState = {
      hasLoaded: true,
      activeSessions: [],
      archivedSessions: [],
    };

    harness.render(useRouter);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifySessionOpenFailedCalls).toEqual([
      { sessionId: 'ses_dead', reason: 'missing-directory' },
    ]);

    // Index refresh re-runs reconcile deps without a second toast.
    globalSessionsState = {
      hasLoaded: true,
      activeSessions: [],
      archivedSessions: [],
    };
    harness.render(useRouter);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifySessionOpenFailedCalls).toHaveLength(1);
  });

  test('identity runtime switch drops a stale path session without missing-directory toast', async () => {
    sessionState.currentSessionId = null;
    sessionState.currentSessionDirectory = null;
    urlRoute.sessionId = 'ses_previous_runtime';
    globalSessionsState = {
      hasLoaded: false,
      activeSessions: [],
      archivedSessions: [],
    };

    harness.render(useRouter);
    // Let mount init rewrite URL, then clear as runtimeEndpointReset does.
    await Promise.resolve();
    await Promise.resolve();
    expect(runtimeEndpointListeners.size).toBeGreaterThan(0);

    urlRoute.sessionId = null;
    for (const listener of runtimeEndpointListeners) {
      listener({
        apiBaseUrl: 'https://b.example',
        previousApiBaseUrl: 'https://a.example',
        runtimeKey: 'runtime-b',
        previousRuntimeKey: 'runtime-a',
        transportIdentityChanged: true,
      });
    }
    // queueMicrotask re-parse from the runtime-switch listener.
    await Promise.resolve();
    await Promise.resolve();

    globalSessionsState = {
      hasLoaded: true,
      activeSessions: [],
      archivedSessions: [],
    };
    harness.render(useRouter);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifySessionOpenFailedCalls).toEqual([]);
    expect(urlRoute.sessionId).toBeNull();
  });

  test('failDeepLinkSession does not re-pin a session id already cleared from the path', async () => {
    sessionState.currentSessionId = null;
    sessionState.currentSessionDirectory = null;
    urlRoute.sessionId = 'ses_stale_route';
    // Start unloaded so reconcile cannot hard-fail before we clear the path.
    globalSessionsState = {
      hasLoaded: false,
      activeSessions: [],
      archivedSessions: [],
    };

    harness.render(useRouter);
    await Promise.resolve();
    await Promise.resolve();

    // Mid-reconcile identity switch: live path cleared while React route may still
    // hold the old session id until the runtime-switch listener re-parses.
    urlRoute.sessionId = null;
    globalSessionsState = {
      hasLoaded: true,
      activeSessions: [],
      archivedSessions: [],
    };
    harness.render(useRouter);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifySessionOpenFailedCalls).toEqual([]);
    // Must not re-write the dead id after the live path was cleared.
    expect(urlRoute.sessionId).toBeNull();
  });
});
