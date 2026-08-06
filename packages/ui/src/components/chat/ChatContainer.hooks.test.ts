import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('ChatContainer source contracts', () => {
    const source = readFileSync(join(here, 'ChatContainer.tsx'), 'utf8');

    test('handlers use useEvent; no React.useCallback', () => {
        expect(source).toContain("from '@reactuses/core'");
        expect(source).toContain('useEvent');
        expect(source).not.toContain('React.useCallback');
        // Comments may mention useCallback as a ban; ban the call form only.
        expect(source).not.toMatch(/(?<![\w.])useCallback\s*\(/);
    });

    test('DOM and browser listeners use @reactuses/core hooks', () => {
        expect(source).toContain('useEventListener');
        expect(source).toContain('useResizeObserver');
        expect(source).toContain('useIsomorphicLayoutEffect');
        expect(source).toContain('useMount');
        expect(source).toContain('useUnmount');
        expect(source).not.toContain('React.useLayoutEffect');
        expect(source).not.toContain('addEventListener(');
        expect(source).not.toContain('new ResizeObserver');
    });

    test('timeline bridge publishes via render-phase refs, not effect rebinding', () => {
        expect(source).toContain('activeTurnChangeRef.current = timelineController.handleActiveTurnChange');
        expect(source).toContain('historyUpwardIntentRef.current = timelineController.handleHistoryUpwardIntent');
        expect(source).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*activeTurnChangeRef\.current\s*=/,
        );
        expect(source).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*historyUpwardIntentRef\.current\s*=/,
        );
    });

    test('native mobile load-older visibility uses the mounted mobile surface state', () => {
        // Capacitor launches MobileApp directly and does not set the hosted-page
        // __OPENCHAMBER_SURFACE__ global. Width/pointer probing can vary while
        // the WebView viewport changes, whereas isMobile is set before mount.
        expect(source).toContain('const showLoadOlderButton = resolveMobileLoadOlderVisibility({');
        expect(source).toContain('isMobile,');
        expect(source).not.toContain('const showLoadOlderButton = isMobileSurfaceRuntime()');
    });

    test('history pagination facts come only from the child-store boundary', () => {
        // ChatContainer subscribes the directory child store boundary directly
        // and never stitches pagination facts from prefetch cursor/complete/limit.
        expect(source).toContain('state.session_history_boundary?.[');
        expect(source).toContain('boundary: historyBoundary');
        expect(source).toContain('limit: historyBoundary.loadedTurns');
        expect(source).not.toContain('sessionPrefetchInfo?.cursor');
        expect(source).not.toContain('sessionPrefetchInfo?.complete');
        expect(source).not.toContain('sessionPrefetchInfo?.limit');
        expect(source).not.toContain('prefetchHasMore');
    });

    test('mobile load-older button is authoritative-only; unknown availability renders nothing', () => {
        // No speculative placeholder: unresolved history boundary (unknown)
        // must not paint the button or a spinner.
        expect(source).not.toContain('isHistoryAvailabilityPending');
        // Visibility = mounted mobile surface && (canLoadEarlier || real
        // user-initiated loadEarlier mutation in flight).
        expect(source).toContain('const showLoadOlderButton = resolveMobileLoadOlderVisibility({');
        expect(source).toContain('canLoadEarlier: timelineController.historySignals.canLoadEarlier');
        expect(source).toContain('isLoadingOlder: timelineController.isLoadingOlder');
        // Busy/disabled is mutation-owned only — background prefetch/SWR
        // loading never drives the button.
        expect(source).toContain('const loadOlderBusy = resolveMobileLoadOlderBusy({ isLoadingOlder });');
        expect(source).toContain('aria-busy={loadOlderBusy}');
        expect(source).toContain("{t('chat.history.loadOlder')}");
    });

    test('explicit history navigation releases the initial entry-stick pin', () => {
        const autoFollowSource = readFileSync(join(here, '../../hooks/useChatAutoFollow.ts'), 'utf8');
        const releaseStart = autoFollowSource.indexOf('const releaseAutoFollow = useEvent');
        const releaseEnd = autoFollowSource.indexOf('const onUpwardUserIntentRef', releaseStart);

        expect(releaseStart).toBeGreaterThan(-1);
        expect(releaseEnd).toBeGreaterThan(releaseStart);
        expect(autoFollowSource.slice(releaseStart, releaseEnd)).toContain('endEntryStick();');
    });

    test('explicit history pagination holds auto-follow released through viewport restoration', () => {
        const autoFollowSource = readFileSync(join(here, '../../hooks/useChatAutoFollow.ts'), 'utf8');
        const timelineSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');

        expect(autoFollowSource).toContain('historyViewportPreservationRef');
        expect(autoFollowSource).toContain('if (historyViewportPreservationRef.current) {');
        expect(timelineSource).toContain('beginHistoryViewportPreservation();');
        expect(timelineSource).toContain('endHistoryViewportPreservation();');
    });

    test('timeline viewport metrics are ResizeObserver-owned and identity-stable on no-op', () => {
        // Trace-20260805: messages-keyed layout effect + fresh setState object
        // forced a second ChatContainer render on every shell-tool part commit.
        const timelineSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');
        expect(timelineSource).toContain('resolvePublishedViewportMetrics');
        expect(timelineSource).toContain('useResizeObserver(');
        expect(timelineSource).not.toContain('[messages, sessionId, isLoadingOlder, scrollRef]');
    });
});
