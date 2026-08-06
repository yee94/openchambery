export type ContextPanelSessionTarget = {
    sessionId: string;
    directory: string;
};

export type ContextPanelNavigationState = {
    anchor: ContextPanelSessionTarget;
    current: ContextPanelSessionTarget;
    stack: ContextPanelSessionTarget[];
};

export type ContextPanelNavigationResult =
    | { status: 'navigated'; state: ContextPanelNavigationState }
    | { status: 'rejected-cross-directory'; state: ContextPanelNavigationState };

export type ContextPanelChatRenderMode = 'react-surface' | 'legacy-iframe';

export const normalizeContextPanelDirectory = (directory: string): string => {
    const raw = directory.trim().replace(/\\/g, '/');
    if (!raw) return '';
    const unc = raw.startsWith('//');
    const normalized = raw.replace(/\/+$/g, '').replace(/\/+/g, '/');
    if (unc && !normalized.startsWith('//')) return `/${normalized}`;
    return normalized || (raw.startsWith('/') ? '/' : '');
};

export const resolveContextPanelChatRenderMode = (): ContextPanelChatRenderMode => 'react-surface';

export const createContextPanelSessionSurfaceId = (directoryKey: string, tabId: string): string => (
    JSON.stringify([normalizeContextPanelDirectory(directoryKey), tabId])
);

export const createContextPanelSessionViewKey = (
    runtimeKey: string,
    surfaceId: string,
    directory: string,
    sessionId: string,
): string => JSON.stringify([runtimeKey, surfaceId, normalizeContextPanelDirectory(directory), sessionId]);

export const resolveContextPanelConfirmedParentViewKey = (
    previousViewKey: string | null,
    currentViewKey: string,
    hasConfirmedParent: boolean,
): string | null => {
    if (hasConfirmedParent) return currentViewKey;
    return previousViewKey === currentViewKey ? previousViewKey : null;
};

const sameTarget = (left: ContextPanelSessionTarget, right: ContextPanelSessionTarget): boolean => (
    left.sessionId === right.sessionId
    && normalizeContextPanelDirectory(left.directory) === normalizeContextPanelDirectory(right.directory)
);

const sameDirectory = (left: string, right: string): boolean => (
    normalizeContextPanelDirectory(left) === normalizeContextPanelDirectory(right)
);

export const createContextPanelNavigationState = (target: ContextPanelSessionTarget): ContextPanelNavigationState => ({
    anchor: target,
    current: target,
    stack: [],
});

export const resolveContextPanelActiveNavigation = (
    navigation: ContextPanelNavigationState | undefined,
    anchor: ContextPanelSessionTarget,
): ContextPanelNavigationState => navigation ?? createContextPanelNavigationState(anchor);

export const resolveContextPanelViewedSessionId = (
    navigation: ContextPanelNavigationState | undefined,
    anchorSessionId: string | null,
): string | null => navigation?.current.sessionId ?? anchorSessionId;

export const navigateContextPanelSession = (state: ContextPanelNavigationState, target: ContextPanelSessionTarget): ContextPanelNavigationState => {
    if (sameTarget(state.current, target)) return state;
    return { ...state, current: target, stack: [...state.stack, state.current] };
};

export const navigateContextPanelBack = (state: ContextPanelNavigationState): ContextPanelNavigationState => {
    const previous = state.stack[state.stack.length - 1];
    return previous ? { ...state, current: previous, stack: state.stack.slice(0, -1) } : state;
};

export const requestContextPanelNavigation = (
    state: ContextPanelNavigationState,
    target: ContextPanelSessionTarget,
    onNavigate: (sessionId: string, directory: string) => boolean | void,
): ContextPanelNavigationResult => {
    if (!sameDirectory(state.anchor.directory, target.directory) || !sameDirectory(state.current.directory, target.directory)) {
        return { status: 'rejected-cross-directory', state };
    }
    if (onNavigate(target.sessionId, target.directory) === false) return { status: 'rejected-cross-directory', state };
    return { status: 'navigated', state: navigateContextPanelSession(state, target) };
};

export const updateContextPanelNavigation = (
    navigationBySurfaceId: Record<string, ContextPanelNavigationState>,
    surfaceId: string,
    target: ContextPanelSessionTarget,
): { accepted: boolean; navigationBySurfaceId: Record<string, ContextPanelNavigationState> } => {
    const state = navigationBySurfaceId[surfaceId];
    if (!state) return { accepted: false, navigationBySurfaceId };
    const result = requestContextPanelNavigation(state, target, () => true);
    if (result.status !== 'navigated') return { accepted: false, navigationBySurfaceId };
    return {
        accepted: true,
        navigationBySurfaceId: result.state === state
            ? navigationBySurfaceId
            : { ...navigationBySurfaceId, [surfaceId]: result.state },
    };
};

export const cleanupContextPanelNavigationSurfaces = (
    navigationBySurfaceId: Record<string, ContextPanelNavigationState>,
    liveSurfaceIds: ReadonlySet<string>,
): Record<string, ContextPanelNavigationState> => {
    let changed = false;
    const next: Record<string, ContextPanelNavigationState> = {};
    for (const [surfaceId, navigation] of Object.entries(navigationBySurfaceId)) {
        if (!liveSurfaceIds.has(surfaceId)) {
            changed = true;
            continue;
        }
        next[surfaceId] = navigation;
    }
    return changed ? next : navigationBySurfaceId;
};

export const cleanupContextPanelNavigationForTabClose = (state: ContextPanelNavigationState, closed: ContextPanelSessionTarget): ContextPanelNavigationState | null => {
    if (sameTarget(state.anchor, closed)) return null;
    if (sameTarget(state.current, closed)) {
        const retained = state.stack.filter((target) => !sameTarget(target, closed));
        const current = retained[retained.length - 1] ?? state.anchor;
        return { ...state, current, stack: retained.slice(0, -1) };
    }
    const stack = state.stack.filter((target) => !sameTarget(target, closed));
    return stack.length === state.stack.length ? state : { ...state, stack };
};

export type ContextPanelTranscriptState = 'directory-mismatch' | 'cold-loading' | 'working-empty' | 'authoritative-empty' | 'partial-error' | 'fatal-error' | 'transcript';

export const resolveContextPanelTranscriptState = (input: {
    directoryMatches: boolean;
    requested: boolean;
    renderable: boolean;
    messageCount: number;
    working: boolean;
    error?: string;
}): ContextPanelTranscriptState => {
    if (!input.directoryMatches) return 'directory-mismatch';
    if (input.error) return input.messageCount > 0 ? 'partial-error' : 'fatal-error';
    if (!input.renderable && input.requested) return 'cold-loading';
    if (input.messageCount === 0) return input.working ? 'working-empty' : 'authoritative-empty';
    return 'transcript';
};

export const resolveContextPanelEnsureForce = (reason: 'active' | 'retry'): boolean => reason === 'retry';

export const resolveContextPanelPartialErrorRetry = (hasMore: boolean): 'load-more' | 'ensure' => hasMore ? 'load-more' : 'ensure';

/**
 * Context-panel load-older entry facts derive only from the directory child
 * store boundary — `has-more` opens the entry; `unknown`/`exhausted` hide it.
 * Prefetch request status never participates.
 */
export const resolveContextPanelHasMore = (boundary: { kind: 'unknown' | 'has-more' | 'exhausted' }): boolean => boundary.kind === 'has-more';

export const createContextPanelViewportRestoreIdentity = (sessionId: string, viewportKey: string): string => `${sessionId}\n${viewportKey}`;

export const shouldRestoreContextPanelViewport = (
    restored: ReadonlySet<string>,
    sessionId: string,
    viewportKey: string,
    renderable: boolean,
): boolean => renderable && !restored.has(createContextPanelViewportRestoreIdentity(sessionId, viewportKey));

export type ContextPanelPrependAnchor = { scrollHeight: number; scrollTop: number };

export type ContextPanelPendingPrepend = {
    token: number;
    viewportKey: string;
    anchor: ContextPanelPrependAnchor;
};

export const captureContextPanelPrependAnchor = (scrollHeight: number, scrollTop: number): ContextPanelPrependAnchor => ({ scrollHeight, scrollTop });

export const resolveContextPanelPrependScrollTop = (anchor: ContextPanelPrependAnchor, nextScrollHeight: number): number => (
    Math.max(0, anchor.scrollTop + Math.max(0, nextScrollHeight - anchor.scrollHeight))
);

export const shouldRequestContextPanelLoadOlder = (hasMore: boolean, isLoading: boolean): boolean => hasMore && !isLoading;

export const shouldShowContextPanelLoadOlder = (hasMore: boolean): boolean => hasMore;

export const shouldApplyContextPanelManualPrependCompensation = (historyVirtualized: boolean): boolean => !historyVirtualized;

export const resolveContextPanelPrependAnchor = (input: {
    hasMore: boolean;
    isLoading: boolean;
    historyVirtualized: boolean;
    scrollHeight: number;
    scrollTop: number;
}): ContextPanelPrependAnchor | null => {
    if (!shouldRequestContextPanelLoadOlder(input.hasMore, input.isLoading)) return null;
    if (!shouldApplyContextPanelManualPrependCompensation(input.historyVirtualized)) return null;
    return captureContextPanelPrependAnchor(input.scrollHeight, input.scrollTop);
};

export const shouldConsumeContextPanelPrepend = (
    pending: ContextPanelPendingPrepend | null,
    completedToken: number | null,
    viewportKey: string,
): pending is ContextPanelPendingPrepend => Boolean(
    pending
    && pending.token === completedToken
    && pending.viewportKey === viewportKey,
);

export const CONTEXT_PANEL_SESSION_CACHE_MAX_VIEWS = 3;
export const CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export type ContextPanelSessionTabMetadata = ContextPanelSessionTarget & { tabId: string; title?: string };

export type ContextPanelMountedSessionView = {
    tabId: string;
    surfaceId: string;
    sessionId: string;
    directory: string;
    viewKey: string;
    estimatedBytes: number;
    lastAccessed: number;
};

export type ContextPanelSessionCacheState = {
    activeViewKey: string | null;
    tabs: Record<string, ContextPanelSessionTabMetadata>;
    mountedViews: Record<string, ContextPanelMountedSessionView>;
};

export type ContextPanelSessionCacheAction =
    | { type: 'touch'; tab: ContextPanelSessionTabMetadata; view: Omit<ContextPanelMountedSessionView, 'estimatedBytes' | 'lastAccessed'>; now: number }
    | { type: 'estimate'; viewKey: string; estimatedBytes: number }
    | { type: 'activate'; viewKey: string | null; now: number }
    | { type: 'close-tab'; tabId: string };

export const estimateContextPanelSessionBytes = (messageCount: number): number => Math.min(
    CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES,
    256 * 1024 + Math.max(0, Math.ceil(messageCount)) * 64 * 1024,
);

const clampEstimatedBytes = (value: number): number => Math.min(
    CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
);

const evictContextPanelViews = (state: ContextPanelSessionCacheState): ContextPanelSessionCacheState => {
    const views = Object.values(state.mountedViews);
    let count = views.length;
    let bytes = views.reduce((total, view) => total + view.estimatedBytes, 0);
    const evicted = new Set<string>();
    const candidates = views.filter((view) => view.viewKey !== state.activeViewKey).sort((left, right) => left.lastAccessed - right.lastAccessed);
    for (const view of candidates) {
        if (count <= CONTEXT_PANEL_SESSION_CACHE_MAX_VIEWS && bytes <= CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES) break;
        evicted.add(view.viewKey);
        count -= 1;
        bytes -= view.estimatedBytes;
    }
    if (evicted.size === 0) return state;
    const mountedViews = { ...state.mountedViews };
    evicted.forEach((viewKey) => delete mountedViews[viewKey]);
    return { ...state, mountedViews };
};

export const reduceContextPanelSessionCache = (state: ContextPanelSessionCacheState, action: ContextPanelSessionCacheAction): ContextPanelSessionCacheState => {
    if (action.type === 'close-tab') {
        const closedViews = Object.values(state.mountedViews).filter((view) => view.tabId === action.tabId);
        if (!state.tabs[action.tabId] && closedViews.length === 0) return state;
        const tabs = { ...state.tabs };
        const mountedViews = { ...state.mountedViews };
        delete tabs[action.tabId];
        closedViews.forEach((view) => delete mountedViews[view.viewKey]);
        const activeViewKey = closedViews.some((view) => view.viewKey === state.activeViewKey) ? null : state.activeViewKey;
        return { activeViewKey, tabs, mountedViews };
    }

    if (action.type === 'activate') {
        if (action.viewKey === state.activeViewKey) return state;
        const view = action.viewKey ? state.mountedViews[action.viewKey] : undefined;
        if (action.viewKey && !view) return state;
        if (!view) return { ...state, activeViewKey: null };
        const mounted = view.lastAccessed === action.now ? state.mountedViews : {
            ...state.mountedViews,
            [view.viewKey]: { ...view, lastAccessed: action.now },
        };
        return evictContextPanelViews({ ...state, activeViewKey: action.viewKey, mountedViews: mounted });
    }

    if (action.type === 'estimate') {
        const view = state.mountedViews[action.viewKey];
        const estimatedBytes = clampEstimatedBytes(action.estimatedBytes);
        if (!view || view.estimatedBytes === estimatedBytes) return state;
        return evictContextPanelViews({
            ...state,
            mountedViews: { ...state.mountedViews, [view.viewKey]: { ...view, estimatedBytes } },
        });
    }

    const existingTab = state.tabs[action.tab.tabId];
    const existingView = state.mountedViews[action.view.viewKey];
    const tabUnchanged = existingTab
        && existingTab.sessionId === action.tab.sessionId
        && existingTab.directory === action.tab.directory
        && existingTab.title === action.tab.title;
    const viewUnchanged = existingView
        && existingView.tabId === action.view.tabId
        && existingView.surfaceId === action.view.surfaceId
        && existingView.lastAccessed === action.now;
    if (tabUnchanged && viewUnchanged && state.activeViewKey === action.view.viewKey) return state;
    const next: ContextPanelSessionCacheState = {
        ...state,
        activeViewKey: action.view.viewKey,
        tabs: tabUnchanged ? state.tabs : { ...state.tabs, [action.tab.tabId]: action.tab },
        mountedViews: {
            ...state.mountedViews,
            [action.view.viewKey]: {
                ...action.view,
                estimatedBytes: existingView?.estimatedBytes ?? estimateContextPanelSessionBytes(0),
                lastAccessed: action.now,
            },
        },
    };
    return evictContextPanelViews(next);
};
