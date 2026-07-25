import { describe, expect, mock, test } from 'bun:test';

import { createSessionViewKey } from './sessionViewCache';

mock.module('./markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: '' }));
mock.module('./ChatMessage', () => ({ default: () => null }));
mock.module('./message/renderCompare', () => ({
    areOptionalRenderRelevantMessagesEqual: () => true,
    areRelevantTurnGroupingContextsEqual: () => true,
    areRenderRelevantMessagesEqual: () => true,
}));
mock.module('./components/TurnItem', () => ({ default: () => null }));
mock.module('./hooks/useTurnRecords', () => ({ useTurnRecords: () => ({ projection: { ungroupedMessageIds: new Set(), lastTurnId: null }, staticTurns: [], streamingTurn: null }) }));
mock.module('./lib/turns/applyRetryOverlay', () => ({ applyRetryOverlay: (messages: unknown[]) => messages }));
mock.module('./lib/turns/streamingTailEntry', () => ({ buildLiveStreamingEntry: (entry: unknown) => entry }));
mock.module('./lib/messageDisplayNormalization', () => ({ getNormalizedMessageForDisplay: (message: unknown) => message, hasCompactionPart: () => false }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => false }));
mock.module('./message/FadeInOnReveal', () => ({ FadeInDisabledProvider: ({ children }: { children: unknown }) => children }));
mock.module('@/lib/userSendAnimation', () => ({ consumePendingUserSendAnimation: () => false, hasPendingUserSendAnimation: () => false }));
mock.module('@/stores/utils/streamDebug', () => ({ streamPerfCount: () => undefined, streamPerfMeasure: (_name: string, measure: () => unknown) => measure() }));
mock.module('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: () => null }));
mock.module('@/sync/sync-context', () => ({ useSessionParts: () => [] }));
mock.module('@/lib/runtimeSurface', () => ({ isMobileSurfaceRuntime: () => false }));
mock.module('@/lib/afterPaintTaskQueue', () => ({ scheduleAfterPaintTask: () => () => undefined }));
mock.module('./lib/historyOverscan', () => ({ getInitialHistoryOverscan: (value: number) => value, getNextHistoryOverscan: (value: number) => value }));
mock.module('./message/parts/DeferredToolHydrationProvider', () => ({ DeferredToolHydrationProvider: ({ children }: { children: unknown }) => children }));
mock.module('./message/parts/taskToolModel', () => ({
    applyAuthoritativeTaskSessionIdToSubtaskParts: (parts: unknown[]) => parts,
    readTaskSessionIdFromOutput: () => null,
    readTaskSessionIdFromRecord: () => null,
}));
mock.module('./markdown/MarkdownHydrationProvider', () => ({ MarkdownHydrationProvider: ({ children }: { children: unknown }) => children }));
mock.module('./lib/markdownHydrationWindow', () => ({
    createInitialMarkdownHydratedKeys: () => new Set(),
    ensureNewestMarkdownKeyHydrated: (keys: Set<string>) => keys,
    getMarkdownHydrationCandidates: () => [],
    pruneMarkdownHydratedKeys: (keys: Set<string>) => keys,
}));
mock.module('./lib/shellBridge', () => ({
    USER_SHELL_MARKER: '',
    isUserShellMarkerMessage: () => false,
    getShellBridgeAssistantDetails: () => ({ hide: false, details: null }),
}));

const {
    createTanstackTimelineSnapshotCache,
    resolveMessageListKeys,
    syncCurrentHistoryVirtualization,
} = await import('./MessageList');

describe('TanStack timeline snapshot cache', () => {
    test('keeps snapshots isolated by virtualizer key', () => {
        const cache = createTanstackTimelineSnapshotCache<string>(16);
        const keys = ['turn:1'];
        const sessionKey = 'ses_1';
        const primaryKey = createSessionViewKey({ runtimeKey: 'runtime-a', directory: '/repo/a', sessionId: sessionKey });
        const alternateDirectoryKey = createSessionViewKey({ runtimeKey: 'runtime-a', directory: '/repo/b', sessionId: sessionKey });
        const alternateRuntimeKey = createSessionViewKey({ runtimeKey: 'runtime-b', directory: '/repo/a', sessionId: sessionKey });

        cache.write(primaryKey, keys, ['primary-snapshot']);
        cache.write(alternateDirectoryKey, keys, ['alternate-directory-snapshot']);
        cache.write(alternateRuntimeKey, keys, ['alternate-runtime-snapshot']);

        expect(cache.read(primaryKey, keys)).toEqual(['primary-snapshot']);
        expect(cache.read(alternateDirectoryKey, keys)).toEqual(['alternate-directory-snapshot']);
        expect(cache.read(alternateRuntimeKey, keys)).toEqual(['alternate-runtime-snapshot']);
    });

    test('keeps session domain identity when virtualizer identity changes', () => {
        expect(resolveMessageListKeys('ses_1', 'panel:ses_1')).toEqual({
            sessionKey: 'ses_1',
            virtualizerKey: 'panel:ses_1',
        });
    });
});

describe('MessageList history virtualization handle state', () => {
    test('an existing handle reader observes the current render virtualization state', () => {
        const state = { current: false };
        const existingHandleReader = () => state.current;

        syncCurrentHistoryVirtualization(state, true);

        expect(existingHandleReader()).toBe(true);
    });
});
