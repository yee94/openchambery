import { describe, expect, test } from 'bun:test';

import {
    CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES,
    captureContextPanelPrependAnchor,
    cleanupContextPanelNavigationSurfaces,
    cleanupContextPanelNavigationForTabClose,
    createContextPanelSessionSurfaceId,
    createContextPanelSessionViewKey,
    createContextPanelViewportRestoreIdentity,
    createContextPanelNavigationState,
    navigateContextPanelBack,
    navigateContextPanelSession,
    reduceContextPanelSessionCache,
    resolveContextPanelActiveNavigation,
    requestContextPanelNavigation,
    resolveContextPanelChatRenderMode,
    resolveContextPanelConfirmedParentViewKey,
    resolveContextPanelEnsureForce,
    resolveContextPanelHasMore,
    resolveContextPanelPartialErrorRetry,
    resolveContextPanelPrependAnchor,
    resolveContextPanelPrependScrollTop,
    resolveContextPanelTranscriptState,
    resolveContextPanelViewedSessionId,
    shouldApplyContextPanelManualPrependCompensation,
    shouldConsumeContextPanelPrepend,
    shouldForceContextPanelEnsureOnFocus,
    shouldRequestContextPanelLoadOlder,
    shouldShowContextPanelLoadOlder,
    shouldRestoreContextPanelViewport,
    updateContextPanelNavigation,
    type ContextPanelSessionCacheState,
} from './contextPanelSessionSurface';

const anchor = { sessionId: 'anchor', directory: '/repo' };
const emptyCache = (): ContextPanelSessionCacheState => ({ activeViewKey: null, tabs: {}, mountedViews: {} });
const touch = (state: ContextPanelSessionCacheState, tabId: string, viewKey: string, now: number) => reduceContextPanelSessionCache(state, {
    type: 'touch',
    tab: { tabId, sessionId: tabId, directory: '/repo' },
    view: { tabId, surfaceId: 'panel', sessionId: tabId, directory: '/repo', viewKey },
    now,
});

describe('context panel session navigation', () => {
    test('keeps the anchor while backtracking the nested navigation stack', () => {
        const initial = createContextPanelNavigationState(anchor);
        const child = navigateContextPanelSession(initial, { sessionId: 'child', directory: '/repo' });
        const grandchild = navigateContextPanelSession(child, { sessionId: 'grandchild', directory: '/repo' });

        expect(grandchild.anchor).toEqual(anchor);
        expect(navigateContextPanelBack(grandchild)).toEqual(child);
        expect(navigateContextPanelBack(child)).toEqual(initial);
    });

    test('rejects a cross-directory target before the parent callback', () => {
        const state = createContextPanelNavigationState(anchor);
        let calls = 0;
        const result = requestContextPanelNavigation(state, { sessionId: 'child', directory: '/other' }, () => {
            calls += 1;
            return true;
        });

        expect(result).toEqual({ status: 'rejected-cross-directory', state });
        expect(calls).toBe(0);
    });

    test('initializes, navigates, backtracks, and cleans tab-local metadata', () => {
        const initial = createContextPanelNavigationState(anchor);
        const navigated = requestContextPanelNavigation(initial, { sessionId: 'child', directory: '/repo' }, () => true).state;
        expect(navigated.current.sessionId).toBe('child');
        expect(navigateContextPanelBack(navigated)).toEqual(initial);
        expect(cleanupContextPanelNavigationForTabClose(navigated, { sessionId: 'child', directory: '/repo' })).toEqual(initial);
        expect(cleanupContextPanelNavigationForTabClose(initial, anchor)).toBeNull();
    });

    test('uses runtime-scoped geometry keys and React surface rendering', () => {
        const surfaceId = createContextPanelSessionSurfaceId('/repo/', 'tab-1');
        expect(surfaceId).toBe(JSON.stringify(['/repo', 'tab-1']));
        expect(createContextPanelSessionViewKey('runtime-a', surfaceId, '/repo/', 'ses_1')).toBe(JSON.stringify(['runtime-a', surfaceId, '/repo', 'ses_1']));
        expect(resolveContextPanelChatRenderMode()).toBe('react-surface');
    });

    test('derives the first active navigation and viewed session before layout state commits', () => {
        const derived = resolveContextPanelActiveNavigation(undefined, anchor);
        expect(derived).toEqual(createContextPanelNavigationState(anchor));
        expect(resolveContextPanelViewedSessionId(derived, 'stale-anchor')).toBe('anchor');
        expect(resolveContextPanelViewedSessionId(undefined, 'anchor')).toBe('anchor');
    });

    test('applies nested navigation from the latest state for delayed callbacks', () => {
        const surfaceId = createContextPanelSessionSurfaceId('/repo', 'tab-1');
        const initial = { [surfaceId]: createContextPanelNavigationState(anchor) };
        const child = updateContextPanelNavigation(initial, surfaceId, { sessionId: 'child', directory: '/repo' });
        const grandchild = updateContextPanelNavigation(child.navigationBySurfaceId, surfaceId, { sessionId: 'grandchild', directory: '/repo' });

        expect(child.accepted).toBe(true);
        expect(grandchild.accepted).toBe(true);
        expect(grandchild.navigationBySurfaceId[surfaceId]?.current.sessionId).toBe('grandchild');
        expect(grandchild.navigationBySurfaceId[surfaceId]?.stack.map((target) => target.sessionId)).toEqual(['anchor', 'child']);
    });

    test('keeps navigation isolated by directory surface identity', () => {
        const repoA = createContextPanelSessionSurfaceId('/repo-a', 'tab-1');
        const repoB = createContextPanelSessionSurfaceId('/repo-b', 'tab-1');
        expect(repoA).not.toBe(repoB);
        expect(cleanupContextPanelNavigationSurfaces({ [repoA]: createContextPanelNavigationState(anchor) }, new Set([repoB]))).toEqual({});
    });
});

describe('context panel transcript state', () => {
    test('keeps confirmed subagent footer ownership across temporary session identity gaps', () => {
        const viewKey = 'subagent-view';
        const confirmed = resolveContextPanelConfirmedParentViewKey(null, viewKey, true);

        expect(confirmed).toBe(viewKey);
        expect(resolveContextPanelConfirmedParentViewKey(confirmed, viewKey, false)).toBe(viewKey);
        expect(resolveContextPanelConfirmedParentViewKey(confirmed, 'other-view', false)).toBeNull();
    });

    test('uses ordinary ensure for activation and force only for explicit retry', () => {
        expect(resolveContextPanelEnsureForce('active')).toBe(false);
        expect(resolveContextPanelEnsureForce('retry')).toBe(true);
    });

    test('force-ensures empty active panel transcripts on focus recovery', () => {
        expect(shouldForceContextPanelEnsureOnFocus({ active: true, visible: true, messageCount: 0 })).toBe(true);
        expect(shouldForceContextPanelEnsureOnFocus({ active: true, visible: true, messageCount: 3 })).toBe(false);
        expect(shouldForceContextPanelEnsureOnFocus({ active: true, visible: false, messageCount: 0 })).toBe(false);
        expect(shouldForceContextPanelEnsureOnFocus({ active: false, visible: true, messageCount: 0 })).toBe(false);
    });

    test('resolves fail-closed and transcript lifecycle states', () => {
        expect(resolveContextPanelTranscriptState({ directoryMatches: false, requested: true, renderable: false, messageCount: 0, working: false })).toBe('directory-mismatch');
        expect(resolveContextPanelTranscriptState({ directoryMatches: true, requested: true, renderable: false, messageCount: 0, working: false })).toBe('cold-loading');
        expect(resolveContextPanelTranscriptState({ directoryMatches: true, requested: true, renderable: true, messageCount: 0, working: true })).toBe('working-empty');
        expect(resolveContextPanelTranscriptState({ directoryMatches: true, requested: true, renderable: true, messageCount: 0, working: false })).toBe('authoritative-empty');
        expect(resolveContextPanelTranscriptState({ directoryMatches: true, requested: true, renderable: true, messageCount: 2, working: false, error: 'failed' })).toBe('partial-error');
        expect(resolveContextPanelTranscriptState({ directoryMatches: true, requested: true, renderable: false, messageCount: 0, working: false, error: 'failed' })).toBe('fatal-error');
    });

    test('preserves prepend viewport position from a stable anchor', () => {
        const anchorState = captureContextPanelPrependAnchor(1000, 240);
        expect(resolveContextPanelPrependScrollTop(anchorState, 1280)).toBe(520);
        expect(resolveContextPanelPrependScrollTop(anchorState, 900)).toBe(240);
        expect(createContextPanelViewportRestoreIdentity('session-1', 'viewport-1')).toBe('session-1\nviewport-1');
        const restored = new Set<string>();
        expect(shouldRestoreContextPanelViewport(restored, 'session-1', 'viewport-1', true)).toBe(true);
        restored.add(createContextPanelViewportRestoreIdentity('session-1', 'viewport-1'));
        expect(shouldRestoreContextPanelViewport(restored, 'session-1', 'viewport-1', true)).toBe(false);
        expect(shouldRestoreContextPanelViewport(restored, 'session-2', 'viewport-1', false)).toBe(false);
    });

    test('selects partial-error retries and manual prepend ownership explicitly', () => {
        expect(resolveContextPanelPartialErrorRetry(true)).toBe('load-more');
        expect(resolveContextPanelPartialErrorRetry(false)).toBe('ensure');
        expect(shouldRequestContextPanelLoadOlder(true, false)).toBe(true);
        expect(shouldRequestContextPanelLoadOlder(false, false)).toBe(false);
        expect(shouldRequestContextPanelLoadOlder(true, true)).toBe(false);
        expect(shouldShowContextPanelLoadOlder(true)).toBe(true);
        expect(shouldShowContextPanelLoadOlder(false)).toBe(false);
        expect(shouldApplyContextPanelManualPrependCompensation(true)).toBe(false);
        expect(shouldApplyContextPanelManualPrependCompensation(false)).toBe(true);
        expect(resolveContextPanelPrependAnchor({ hasMore: false, isLoading: false, historyVirtualized: false, scrollHeight: 100, scrollTop: 20 })).toBeNull();
        expect(resolveContextPanelPrependAnchor({ hasMore: true, isLoading: false, historyVirtualized: true, scrollHeight: 100, scrollTop: 20 })).toBeNull();
    });

    test('consumes prepend work only for its current viewport identity', () => {
        const pending = { token: 7, viewportKey: 'viewport-a', anchor: captureContextPanelPrependAnchor(100, 20) };

        expect(shouldConsumeContextPanelPrepend(pending, 7, 'viewport-a')).toBe(true);
        expect(shouldConsumeContextPanelPrepend(pending, 7, 'viewport-b')).toBe(false);
        expect(shouldConsumeContextPanelPrepend(pending, 8, 'viewport-a')).toBe(false);
    });

    test('boundary-only updates drive the load-older entry; prefetch status is never a fact', () => {
        // unknown → hidden
        expect(resolveContextPanelHasMore({ kind: 'unknown' })).toBe(false);
        // unknown → has-more boundary-only update opens the entry
        expect(resolveContextPanelHasMore({ kind: 'has-more' })).toBe(true);
        // unknown → exhausted boundary-only update keeps the entry hidden
        expect(resolveContextPanelHasMore({ kind: 'exhausted' })).toBe(false);
        // cached boundaries re-apply immediately on re-entry — no prefetch
        // status participates in either direction.
        expect(resolveContextPanelHasMore({ kind: 'has-more' })).toBe(true);
        expect(resolveContextPanelHasMore({ kind: 'exhausted' })).toBe(false);
        // The entry fact feeds show/request gates unchanged.
        expect(shouldShowContextPanelLoadOlder(resolveContextPanelHasMore({ kind: 'has-more' }))).toBe(true);
        expect(shouldShowContextPanelLoadOlder(resolveContextPanelHasMore({ kind: 'unknown' }))).toBe(false);
        expect(shouldRequestContextPanelLoadOlder(resolveContextPanelHasMore({ kind: 'has-more' }), false)).toBe(true);
        expect(shouldRequestContextPanelLoadOlder(resolveContextPanelHasMore({ kind: 'exhausted' }), false)).toBe(false);
    });
});

describe('context panel session cache', () => {
    test('enforces three mounted views and evicts by LRU order', () => {
        let state = emptyCache();
        for (let index = 1; index <= 3; index += 1) state = touch(state, `tab-${index}`, `view-${index}`, index);
        state = reduceContextPanelSessionCache(state, { type: 'activate', viewKey: 'view-1', now: 4 });
        state = touch(state, 'tab-4', 'view-4', 5);

        expect(Object.keys(state.mountedViews)).toHaveLength(3);
        expect(state.mountedViews['view-1']).toBeDefined();
        expect(state.mountedViews['view-2']).toBe(undefined);
    });

    test('evicts inactive views directly by the 32 MiB byte limit while preserving active', () => {
        let state = touch(touch(emptyCache(), 'tab-1', 'view-1', 1), 'tab-2', 'view-2', 2);
        state = reduceContextPanelSessionCache(state, { type: 'estimate', viewKey: 'view-1', estimatedBytes: 20 * 1024 * 1024 });
        state = reduceContextPanelSessionCache(state, { type: 'estimate', viewKey: 'view-2', estimatedBytes: 20 * 1024 * 1024 });

        expect(state.mountedViews['view-2']).toBeDefined();
        expect(state.mountedViews['view-1']).toBe(undefined);
        expect(Object.values(state.mountedViews).reduce((total, view) => total + view.estimatedBytes, 0) <= CONTEXT_PANEL_SESSION_CACHE_MAX_BYTES).toBe(true);
    });

    test('keeps estimate updates out of LRU and returns stable state for no-ops', () => {
        let state = touch(touch(emptyCache(), 'tab-1', 'view-1', 1), 'tab-2', 'view-2', 2);
        const before = state.mountedViews['view-1']!.lastAccessed;
        state = reduceContextPanelSessionCache(state, { type: 'estimate', viewKey: 'view-1', estimatedBytes: 1024 });
        expect(state.mountedViews['view-1']!.lastAccessed).toBe(before);
        expect(reduceContextPanelSessionCache(state, { type: 'estimate', viewKey: 'view-1', estimatedBytes: 1024 })).toBe(state);
        expect(reduceContextPanelSessionCache(state, { type: 'activate', viewKey: 'missing', now: 3 })).toBe(state);
    });

    test('clears active protection when a non-chat tab becomes active', () => {
        const state = touch(emptyCache(), 'tab-1', 'view-1', 1);
        const inactive = reduceContextPanelSessionCache(state, { type: 'activate', viewKey: null, now: 2 });
        expect(inactive.activeViewKey).toBeNull();
    });

    test('keeps tab metadata stable across nested views and removes every view on tab close', () => {
        let state = touch(emptyCache(), 'tab-1', 'view-root', 1);
        state = touch(state, 'tab-1', 'view-child', 2);
        expect(Object.keys(state.tabs)).toHaveLength(1);
        expect(Object.keys(state.mountedViews)).toHaveLength(2);

        state = reduceContextPanelSessionCache(state, { type: 'close-tab', tabId: 'tab-1' });
        expect(Object.keys(state.mountedViews)).toHaveLength(0);
        expect(Object.keys(state.tabs)).toHaveLength(0);
    });
});
