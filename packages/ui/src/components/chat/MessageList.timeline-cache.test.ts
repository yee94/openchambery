import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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
mock.module('./lib/messageDisplayNormalization', () => ({
    getNormalizedMessageForDisplay: (message: unknown) => message,
    hasCompactionPart: () => false,
    isCompactionCommandMessage: () => false,
    isCompactionCommandParts: () => false,
}));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => false }));
mock.module('./message/FadeInOnReveal', () => ({ FadeInDisabledProvider: ({ children }: { children: unknown }) => children }));
mock.module('@/lib/userSendAnimation', () => ({
    consumePendingUserSendAnimation: () => false,
    hasPendingUserSendAnimation: () => false,
    resolveConsumedSendMessageId: () => null,
    clearConsumedUserSendAnimation: () => undefined,
}));
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
    getMarkdownHydrationBatch: () => [],
    pruneMarkdownHydratedKeys: (keys: Set<string>) => keys,
    readMarkdownHydrationRestore: () => undefined,
    writeMarkdownHydrationRestore: () => undefined,
}));
mock.module('./lib/shellBridge', () => ({
    USER_SHELL_MARKER: '',
    isUserShellMarkerMessage: () => false,
    getShellBridgeAssistantDetails: () => ({ hide: false, details: null }),
}));

const {
    buildMeasurementSeedFromSizes,
    createTanstackTimelineSnapshotCache,
    resolveMessageListKeys,
    resolveActivityExpansionDisposition,
    resolveDefaultActivityExpanded,
    resolveMarkdownPreloadEntries,
    resolveMarkdownPreloadReleaseWhileScrolling,
    resolveMarkdownVisibleReleaseLimit,
    resolveTanstackEstimatedEntrySize,
    resolveTanstackEstimateMinSamples,
    resolveTimelineVirtualizerCacheKey,
    shouldInvalidateVirtualizerMeasurementsOnColumnResize,
    resolveTanstackHistoryFrameStyle,
    applyTanstackHistoryFrameMinHeight,
    resolveToggledActivityExpanded,
    resolveTurnActivityExpandedByDefault,
    resolveTurnActivityPresentation,
    shouldShowCompactionStatus,
    syncCurrentHistoryVirtualization,
} = await import('./MessageList');

describe('history virtualization transition anchor source contract', () => {
    test('captures the visible message before none-to-TanStack transition and restores it before paint', () => {
        const source = readFileSync(join(here, 'MessageList.tsx'), 'utf8');

        expect(source).toContain('captureVirtualizationTransitionAnchor');
        expect(source).toContain("committedEngineRef.current === 'none' && isTanstack");
        expect(source).toContain('tanstackVirtualizer.scrollToIndex(index, { align: \'start\' });');
        expect(source).toContain('container.scrollTop += delta;');
        expect(source).toContain('useIsomorphicLayoutEffect(() => {');
    });
});

describe('turn activity expansion state', () => {
    test('active Activity defaults expanded while its Working header remains live', () => {
        for (const activityRenderMode of ['collapsed', 'summary'] as const) {
            expect(resolveTurnActivityExpandedByDefault({
                expansionDisposition: 'active',
                activityRenderMode,
                isLastTurn: true,
                isActivelyProcessing: true,
                hasConfirmedFinalBody: false,
            })).toBe(true);
        }
    });

    test('collapsed mode defaults settled dispositions to collapsed', () => {
        for (const disposition of ['normal', 'abnormal'] as const) {
            expect(resolveDefaultActivityExpanded(disposition, 'collapsed')).toBe(false);
        }
        expect(resolveDefaultActivityExpanded(undefined, 'collapsed')).toBe(false);
    });

    test('summary mode defaults settled dispositions to expanded', () => {
        for (const disposition of ['normal', 'abnormal'] as const) {
            expect(resolveDefaultActivityExpanded(disposition, 'summary')).toBe(true);
        }
        expect(resolveDefaultActivityExpanded(undefined, 'summary')).toBe(true);
    });

    test('settled presentation of idle/historical actives follows the render mode', () => {
        // Presentation settles non-live actives to abnormal before default resolution.
        const settled = resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: false,
            sessionIsWorking: false,
        });
        expect(settled.completionDisposition).toBe('abnormal');
        expect(resolveDefaultActivityExpanded(settled.completionDisposition, 'collapsed')).toBe(false);
        expect(resolveDefaultActivityExpanded(settled.completionDisposition, 'summary')).toBe(true);

        const live = resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: true,
        });
        expect(live.completionDisposition).toBe('active');
        expect(resolveTurnActivityExpandedByDefault({
            expansionDisposition: live.completionDisposition,
            activityRenderMode: 'collapsed',
            isLastTurn: true,
            isActivelyProcessing: true,
            hasConfirmedFinalBody: false,
        })).toBe(true);
    });

    test('last open turn stays expanded even when sessionIsWorking flaps idle between tools', () => {
        // Header presentation demotes active→abnormal when status is idle, but
        // expansion uses resolveActivityExpansionDisposition on the raw turn.
        const demoted = resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: false,
        });
        expect(demoted.completionDisposition).toBe('abnormal');
        const expansion = resolveActivityExpansionDisposition({
            isLastTurn: true,
            turnCompletionDisposition: 'active',
            headerPresentationDisposition: demoted.completionDisposition,
            hasAssistantMessages: true,
        });
        expect(expansion).toBe('active');
        expect(resolveTurnActivityExpandedByDefault({
            expansionDisposition: expansion,
            activityRenderMode: 'collapsed',
            isLastTurn: true,
            isActivelyProcessing: false,
            hasConfirmedFinalBody: false,
        })).toBe(true);
        expect(resolveDefaultActivityExpanded(demoted.completionDisposition, 'collapsed')).toBe(false);
    });

    test('last turn without a confirmed final body always stays expanded', () => {
        for (const disposition of ['active', 'normal', 'abnormal'] as const) {
            expect(
                resolveDefaultActivityExpanded(disposition, 'collapsed', {
                    isLastTurn: true,
                    hasConfirmedFinalBody: false,
                }),
            ).toBe(true);
        }
    });

    test('last turn with a confirmed final body follows the render mode', () => {
        expect(
            resolveDefaultActivityExpanded('normal', 'collapsed', {
                isLastTurn: true,
                hasConfirmedFinalBody: true,
            }),
        ).toBe(false);
        expect(
            resolveDefaultActivityExpanded('normal', 'summary', {
                isLastTurn: true,
                hasConfirmedFinalBody: true,
            }),
        ).toBe(true);
    });

    test('last active turn stays expanded through busy-status flaps', () => {
        expect(
            resolveTurnActivityExpandedByDefault({
                expansionDisposition: 'active',
                activityRenderMode: 'collapsed',
                isLastTurn: true,
                isActivelyProcessing: false,
                hasConfirmedFinalBody: true,
            }),
        ).toBe(true);
    });

    test('a toggle flips the current expansion state in both directions', () => {
        expect(resolveToggledActivityExpanded(false)).toBe(true);
        expect(resolveToggledActivityExpanded(true)).toBe(false);
    });
});

describe('shouldShowCompactionStatus', () => {
    const base = {
        chatRenderMode: 'sorted' as const,
        activityPresentationKind: 'compaction' as const,
        hasVisibleActivitySegments: false,
        hasAssistantMessages: false,
        completionDisposition: 'active' as const,
        isLastTurn: true,
        sessionIsWorking: true,
    };

    test('sorted compaction no segments + active + last + working => true', () => {
        expect(shouldShowCompactionStatus(base)).toBe(true);
    });

    test('active but older turn or idle => false', () => {
        expect(shouldShowCompactionStatus({ ...base, isLastTurn: false })).toBe(false);
        expect(shouldShowCompactionStatus({ ...base, sessionIsWorking: false })).toBe(false);
        expect(shouldShowCompactionStatus({ ...base, isLastTurn: false, sessionIsWorking: false })).toBe(false);
    });

    test('normal/abnormal settled without assistants => true even when not last or idle', () => {
        expect(shouldShowCompactionStatus({
            ...base,
            completionDisposition: 'normal',
            isLastTurn: false,
            sessionIsWorking: false,
        })).toBe(true);
        expect(shouldShowCompactionStatus({
            ...base,
            completionDisposition: 'abnormal',
            isLastTurn: false,
            sessionIsWorking: false,
        })).toBe(true);
    });

    test('assistant messages own the disclosure header instead of the pre-assistant status', () => {
        expect(shouldShowCompactionStatus({
            ...base,
            hasAssistantMessages: true,
        })).toBe(false);
        expect(shouldShowCompactionStatus({
            ...base,
            completionDisposition: 'normal',
            hasAssistantMessages: true,
        })).toBe(false);
    });

    test('live/default/has segments => false', () => {
        expect(shouldShowCompactionStatus({ ...base, chatRenderMode: 'live' })).toBe(false);
        expect(shouldShowCompactionStatus({ ...base, activityPresentationKind: 'default' })).toBe(false);
        expect(shouldShowCompactionStatus({ ...base, hasVisibleActivitySegments: true })).toBe(false);
        expect(shouldShowCompactionStatus({
            ...base,
            completionDisposition: 'normal',
            hasVisibleActivitySegments: true,
        })).toBe(false);
    });
});

describe('resolveTurnActivityPresentation', () => {
    test('keeps live active only for the last turn while the session is working', () => {
        expect(resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: true,
            durationMs: undefined,
        })).toEqual({
            completionDisposition: 'active',
            durationMs: undefined,
        });
    });

    test('settles orphaned active turns when the session is idle or the turn is historical', () => {
        expect(resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: true,
            sessionIsWorking: false,
            durationMs: 12_000,
        })).toEqual({
            completionDisposition: 'abnormal',
            durationMs: 12_000,
        });
        expect(resolveTurnActivityPresentation({
            completionDisposition: 'active',
            isLastTurn: false,
            sessionIsWorking: true,
            durationMs: 5_000,
        })).toEqual({
            completionDisposition: 'abnormal',
            durationMs: 5_000,
        });
    });

    test('preserves normal and abnormal dispositions and duration', () => {
        expect(resolveTurnActivityPresentation({
            completionDisposition: 'normal',
            isLastTurn: true,
            sessionIsWorking: false,
            durationMs: 4_000,
        })).toEqual({
            completionDisposition: 'normal',
            durationMs: 4_000,
        });
        expect(resolveTurnActivityPresentation({
            completionDisposition: 'abnormal',
            isLastTurn: true,
            sessionIsWorking: true,
            durationMs: 8_000,
        })).toEqual({
            completionDisposition: 'abnormal',
            durationMs: 8_000,
        });
    });
});

describe('buildMeasurementSeedFromSizes', () => {
    test('lays out measured rows end to end so the virtualizer inherits the real height', () => {
        const seed = buildMeasurementSeedFromSizes(
            ['turn:1', 'turn:2'],
            new Map([['turn:1', 400], ['turn:2', 250]]),
            320,
        );

        expect(seed).toEqual([
            { index: 0, key: 'turn:1', start: 0, size: 400, end: 400, lane: 0 },
            { index: 1, key: 'turn:2', start: 400, size: 250, end: 650, lane: 0 },
        ]);
    });

    test('falls back to the estimate for entries the switching commit just added', () => {
        const seed = buildMeasurementSeedFromSizes(
            ['turn:new', 'turn:1'],
            new Map([['turn:1', 400]]),
            320,
        );

        expect(seed.map((item) => item.size)).toEqual([320, 400]);
        expect(seed[1]?.start).toBe(320);
    });

    test('stays empty with nothing measured so a cold mount keeps its own estimates', () => {
        expect(buildMeasurementSeedFromSizes(['turn:1'], new Map(), 320)).toEqual([]);
    });
});

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

    test('scopes timeline measurement snapshots by activity density', () => {
        const cache = createTanstackTimelineSnapshotCache<string>(16);
        const keys = ['turn:1', 'turn:2'];
        const base = 'runtime-a|/repo|ses_1';
        const collapsedKey = resolveTimelineVirtualizerCacheKey(base, 'collapsed');
        const summaryKey = resolveTimelineVirtualizerCacheKey(base, 'summary');

        cache.write(collapsedKey, keys, ['collapsed-geometry']);
        cache.write(summaryKey, keys, ['summary-geometry']);

        expect(collapsedKey).not.toBe(summaryKey);
        expect(cache.read(collapsedKey, keys)).toEqual(['collapsed-geometry']);
        expect(cache.read(summaryKey, keys)).toEqual(['summary-geometry']);
        // Cross-mode read must miss so a collapsed mount never seeds from summary heights.
        expect(cache.read(collapsedKey, keys)).not.toEqual(cache.read(summaryKey, keys));
    });
});

describe('collapsed-mode virtualizer estimate and markdown preload', () => {
    test('uses a shorter cold estimate in collapsed mode than summary mode', () => {
        const collapsed = resolveTanstackEstimatedEntrySize('collapsed');
        const summary = resolveTanstackEstimatedEntrySize('summary');
        expect(collapsed).toBeLessThan(summary);
        expect(collapsed).toBeGreaterThanOrEqual(120);
        expect(summary).toBe(320);
    });

    test('converges the adaptive estimate with fewer samples while collapsed', () => {
        expect(resolveTanstackEstimateMinSamples('collapsed')).toBeLessThan(
            resolveTanstackEstimateMinSamples('summary'),
        );
        expect(resolveTanstackEstimateMinSamples('collapsed')).toBe(2);
        expect(resolveTanstackEstimateMinSamples('summary')).toBe(5);
    });

    test('widens markdown preload when collapsed or when the visible range is dense', () => {
        expect(resolveMarkdownPreloadEntries('summary', 4)).toBe(6);
        expect(resolveMarkdownPreloadEntries('collapsed', 4)).toBe(12);
        // Visible range larger than the base window must widen preload so
        // upward travel does not paint skeletons for on-screen rows.
        expect(resolveMarkdownPreloadEntries('collapsed', 18)).toBe(18);
        expect(resolveMarkdownPreloadEntries('summary', 18)).toBe(18);
    });

    test('meters scroll-time preload and idle visible release more tightly when collapsed', () => {
        expect(resolveMarkdownPreloadReleaseWhileScrolling('collapsed')).toBeGreaterThan(
            resolveMarkdownPreloadReleaseWhileScrolling('summary'),
        );
        expect(resolveMarkdownVisibleReleaseLimit('collapsed')).toBeLessThan(
            resolveMarkdownVisibleReleaseLimit('summary'),
        );
        expect(resolveMarkdownVisibleReleaseLimit('collapsed')).toBe(4);
        expect(resolveMarkdownVisibleReleaseLimit('summary')).toBe(6);
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

describe('runtime default list engine', () => {
    test('TanStack is the default; LegendList is opt-in via oc:legend-timeline=1', () => {
        const storeSource = readFileSync(join(here, '..', '..', 'stores', 'useFeatureFlagsStore.ts'), 'utf8');
        const legendStart = storeSource.indexOf('export const readLegendTimelineEnabled');
        const markstreamStart = storeSource.indexOf('export const readMarkstreamReactEnabled');
        expect(legendStart).toBeGreaterThan(-1);
        expect(markstreamStart).toBeGreaterThan(legendStart);
        const legendSlice = storeSource.slice(legendStart, markstreamStart);
        expect(legendSlice).toContain('readExactOneFlag');
        expect(legendSlice).not.toContain("!== '0'");
    });
});

describe('cold-start markdown pin reveal', () => {
    test('LegendList and TanStack both hide until seeded markdown reports ready', () => {
        const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf8');
        const timelineSource = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');
        expect(messageListSource).toContain('useMarkdownPinReveal');
        expect(messageListSource).toContain('setPinRevealGeneration((current) => current + 1)');
        expect(messageListSource).toContain('pinRevealGeneration={pinRevealGeneration}');
        expect(timelineSource).toContain('useMarkdownPinReveal');
        expect(timelineSource).toContain('mergeMarkdownPinRevealStyle(style, pinHidden)');
        expect(timelineSource).toContain('resolveMarkdownPinRevealKeys');
    });
});

describe('batched virtualizer resize writes', () => {
    test('TanStack resizeItem and LegendList row measure share the microtask batch helper', () => {
        const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf8');
        const timelineSource = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');
        expect(messageListSource).toContain('installBatchedResizeItem(tanstackVirtualizer)');
        expect(timelineSource).toContain('createSharedElementSizeBatch');
        expect(timelineSource).not.toContain('const height = node.offsetHeight');
    });
});

describe('column-width virtualizer invalidation', () => {
    test('ignores the first observation and sub-pixel wobble, then invalidates a real column shrink', () => {
        expect(shouldInvalidateVirtualizerMeasurementsOnColumnResize(null, 800)).toBe(false);
        expect(shouldInvalidateVirtualizerMeasurementsOnColumnResize(800.2, 799.6)).toBe(false);
        expect(shouldInvalidateVirtualizerMeasurementsOnColumnResize(800, 420)).toBe(true);
        expect(shouldInvalidateVirtualizerMeasurementsOnColumnResize(420, 800)).toBe(true);
        expect(shouldInvalidateVirtualizerMeasurementsOnColumnResize(800, 0)).toBe(false);
    });

    test('StaticHistoryList measures again after the transcript column changes width', () => {
        const source = readFileSync(join(here, 'MessageList.tsx'), 'utf8');
        expect(source).toContain('shouldInvalidateVirtualizerMeasurementsOnColumnResize');
        expect(source).toContain('tanstackVirtualizer.measure()');
        expect(source).toContain('useResizeObserver(');
    });
});

describe('history virtualizer frame vs live tail', () => {
    test('reserves unrendered range with padding and minHeight instead of a fixed height box', () => {
        expect(resolveTanstackHistoryFrameStyle(0, 0, 0)).toEqual({
            paddingTop: 0,
            paddingBottom: 0,
            minHeight: 0,
        });
        expect(resolveTanstackHistoryFrameStyle(1000, 2500, 5000)).toEqual({
            paddingTop: 1000,
            paddingBottom: 2500,
            minHeight: 5000,
        });
        expect(resolveTanstackHistoryFrameStyle(4000, 5000, 5000)).toEqual({
            paddingTop: 4000,
            paddingBottom: 0,
            minHeight: 5000,
        });
        expect(resolveTanstackHistoryFrameStyle(-10, 800, 500)).toEqual({
            paddingTop: 0,
            paddingBottom: 0,
            minHeight: 500,
        });
    });

    test('a visible window taller than its cache still keeps the tail below the history frame', () => {
        const frame = resolveTanstackHistoryFrameStyle(800, 1200, 3000);
        const cachedVisible = 1200 - 800;
        const actualVisible = 1685;
        const innerHeight = frame.paddingTop + actualVisible + frame.paddingBottom;
        expect(innerHeight).toBe(frame.minHeight + (actualVisible - cachedVisible));
        expect(innerHeight).toBeGreaterThan(frame.minHeight);
    });

    test('scrollToFn writes minHeight and clears a leftover height lock', () => {
        const element = { style: { height: '12000px', minHeight: '' } };
        applyTanstackHistoryFrameMinHeight(element as unknown as HTMLElement, 3600);
        expect(element.style.height).toBe('');
        expect(element.style.minHeight).toBe('3600px');
        applyTanstackHistoryFrameMinHeight(null, 3600);
    });

    test('StaticHistoryList does not lock the history frame to cached totalSize height', () => {
        const source = readFileSync(join(here, 'MessageList.tsx'), 'utf8');
        expect(source).toContain('resolveTanstackHistoryFrameStyle');
        expect(source).toContain('applyTanstackHistoryFrameMinHeight');
        expect(source).toContain('minHeight: historyFrameStyle.minHeight');
        expect(source).toContain('paddingBottom: historyFrameStyle.paddingBottom');
        expect(source).not.toContain('style={{ height: tanstackVirtualizer.getTotalSize() }}');
        expect(source).not.toContain("sizeElement.style.height = `${instance.getTotalSize()}px`");
    });
});
