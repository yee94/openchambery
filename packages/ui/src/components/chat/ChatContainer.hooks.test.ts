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

    test('load-error retry reloads the transcript and enters the hydrating skeleton', () => {
        expect(source).toContain('retryTranscriptInitial');
        expect(source).toContain('userRetrying: isRetryingSessionHistory');
        expect(source).toContain('onClick={retrySessionHistory}');
        expect(source).not.toContain('sync.syncSession(currentSessionId, true)');
    });

    test('uses repository P0 as the transcript and composer reveal gate', () => {
        expect(source).toContain('useSessionTranscriptHydration');
        expect(source).toContain('p0Satisfied: transcriptHydration.p0Satisfied');
        expect(source).toContain('hasBusyShell: sessionIsWorking && hasTranscriptShell');
        expect(source).toContain('hasImmediateShell: pendingUserMessages.length > 0 || historyPrefix.length > 0');
        expect(source).toContain("if (sessionTranscriptGate === 'pass' && renderedViewportMessages.length > 0)");
    });

    test('history pagination facts come only from the transcript repository projection', () => {
        // Ticket 02: ChatContainer reads pagination via useSessionTranscriptPagination
        // (repository getPagination) and never stitches facts from prefetch.
        expect(source).toContain('useSessionTranscriptPagination');
        expect(source).toContain('transcriptPagination.boundary');
        expect(source).toContain('boundary: historyBoundary');
        expect(source).toContain('limit: historyBoundary.loadedTurns');
        expect(source).not.toContain('state.session_history_boundary?.[');
        expect(source).not.toContain('sessionPrefetchInfo?.cursor');
        expect(source).not.toContain('sessionPrefetchInfo?.complete');
        expect(source).not.toContain('sessionPrefetchInfo?.limit');
        expect(source).not.toContain('prefetchHasMore');
    });

    test('historyMeta.loading is sync/assistant only — never stuck prefetch loading', () => {
        // Timeline wait gate (historyLoading) must not OR prefetch status.
        // Stuck sessionPrefetch status==='loading' blocked mobile load-more for
        // wait window with toast and zero fetch; cold transcript gate still uses prefetch.
        expect(source).toContain('resolveChatHistoryPaginationLoading');
        expect(source).toContain('syncHistoryLoading');
        expect(source).toContain('syncLoading: syncHistoryLoading');
        expect(source).toContain('assistantLoading:');
        expect(source).not.toContain("sessionPrefetchInfo?.status === 'loading'");
        // Prefetch remains on the cold transcript gate path.
        expect(source).toContain('prefetchStatus: sessionPrefetchInfo?.status');
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
        // Desktop scroll/auto-fill needs a restrained status while wait can be long.
        expect(source).toContain('resolveDesktopLoadOlderStatusVisibility');
        expect(source).toContain("{t('chat.history.loadingMore')}");
        expect(source).toContain('showDesktopLoadOlderStatus');
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

    test('legend path releases end pinning before an explicit older-history fetch', () => {
        // A prepend is a data change, and maintainScrollAtEnd fires on
        // dataChange: with follow still armed the list reads the content
        // growth as an end correction and throws the viewport to the live
        // edge. Mobile only reaches history through this button, so the
        // gesture-driven release never covers it.
        const clickStart = source.indexOf('const handleLoadOlderClick = useEvent');
        const clickEnd = source.indexOf('});', clickStart);

        expect(clickStart).toBeGreaterThan(-1);
        const clickBody = source.slice(clickStart, clickEnd);
        expect(clickBody).toContain('setLegendFollowReleased(true);');
        // Unconditional. Gating this on being away from the live edge trusted
        // the at-end signal, and a stale-true reading skipped the release
        // silently — which is how the prepend could still reach the live edge.
        expect(clickBody).not.toContain('if (!legendIsAtEnd)');
        // Release must precede the fetch that commits the prepend.
        expect(clickBody.indexOf('setLegendFollowReleased(true);'))
            .toBeLessThan(clickBody.indexOf('timelineLoadEarlier('));
        // Released state reaches the list as suspended follow.
        expect(source).toContain('timelineFollowSuspended={legendFollowReleased}');
        expect(source).toContain('timelineFollowEnabled={!pendingRevealWork && !timelineFollowSuspended}');
    });

    /**
     * Releasing follow is not enough on its own: the list decides what to do
     * with a prepend inside the commit that delivers it, so the read position
     * has to be captured — and end maintenance stood down — while the
     * transcript is still untouched. Every load path funnels through the
     * controller's `loadEarlier`, so the arm hangs off that rather than off the
     * button, which is the only path mobile uses but not the only one there is.
     */
    test('an older-history fetch arms the timeline anchor before it goes out', () => {
        const controllerSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');

        expect(controllerSource).toContain('onWillLoadEarlier?: () => void;');
        expect(controllerSource).toContain('onWillLoadEarlier?.();');
        // Only for user-initiated loads: automatic backfill has no read
        // position to protect and must leave end maintenance alone.
        const armIndex = controllerSource.indexOf('onWillLoadEarlier?.();');
        expect(controllerSource.slice(0, armIndex)).toContain('if (options?.userInitiated) {');
        // Armed before the fetch, not after it resolves.
        expect(armIndex).toBeLessThan(controllerSource.indexOf('loadEarlierMutation.mutateAsync('));

        expect(source).toContain('onWillLoadEarlier: armTimelineHistoryAnchor,');
        expect(source).toContain('setTimelineHistoryAnchorToken((token) => token + 1);');
        expect(source).toContain('timelineHistoryAnchorToken={timelineHistoryAnchorToken}');
    });

    /**
     * Auto-follow is disabled on the legend path so it cannot fight the list
     * for the scroll position. Its goToBottom therefore returns without
     * writing. The visible scroll-to-bottom control used to call that no-op
     * and nothing moved. The list handle talks to LegendList.scrollToEnd.
     */
    test('resume-to-latest scrolls the legend list, not the disabled auto-follow writer', () => {
        const resumeStart = source.indexOf('const resumeToLatestInstant = useEvent');
        expect(resumeStart).toBeGreaterThan(-1);
        const resumeBody = source.slice(resumeStart, source.indexOf('});', resumeStart));
        expect(resumeBody).toContain('setLegendFollowReleased(false);');
        expect(resumeBody).toContain('messageListRef.current?.scrollToBottom();');
        expect(resumeBody.indexOf('messageListRef.current?.scrollToBottom();'))
            .toBeLessThan(resumeBody.indexOf("goToBottom('instant')"));
        // The visible control goes through turn navigation, which must use
        // this wrapper — the controller's own resume still calls goToBottom
        // and would otherwise remain a no-op for the button.
        expect(source).toContain('resumeToBottom: resumeToLatestInstant,');
        expect(source).not.toContain('resumeToBottom: timelineController.resumeToBottomInstant,');
    });

    test('legend footer keeps composer inset without the live status row', () => {
        const footerStart = source.indexOf('footerSlot={(');
        expect(footerStart).toBeGreaterThan(-1);
        const footSpacer = source.indexOf('MOBILE_TIMELINE_FOOT_SPACER_HEIGHT', footerStart);
        expect(footSpacer).toBeGreaterThan(footerStart);
        const footer = source.slice(footerStart, footSpacer);
        expect(footer).not.toContain('StatusRowContainer');
        expect(source).toContain('<StatusRowContainer />');
    });

    test('composer send re-arms legend follow so a mid-history send can park', () => {
        expect(source).toContain('const scrollViewportOnSend = useEvent');
        const sendStart = source.indexOf('const scrollViewportOnSend = useEvent');
        const sendBody = source.slice(sendStart, source.indexOf('});', sendStart));
        expect(sendBody).toContain('setLegendFollowReleased(false);');
        expect(sendBody).toContain('scrollToBottomOnSend()');
        expect(source).toContain('scrollToBottom={scrollViewportOnSend}');
        expect(source).not.toContain('scrollToBottom={scrollToBottomOnSend}');
    });

    test('latches confirmed subagent footer identity through temporary session identity gaps', () => {
        // session.updated hides subagents from the live directory list, so
        // parentSessionTarget can go null while the child is still on screen.
        // The banner must keep the last-known parent + agent/model instead of
        // flashing to the metadata-less "cannot send to child" foot.
        expect(source).toContain('resolveSubagentReadOnlyBannerLatch');
        expect(source).toContain('const nextSubagentBannerLatch = resolveSubagentReadOnlyBannerLatch(');
        expect(source).toContain('const resolvedParentSessionTarget = parentSessionTarget ?? nextSubagentBannerLatch?.parentTarget ?? null');
        expect(source).toContain('const bannerExecution = nextSubagentBannerLatch?.execution ?? sessionExecution');
        expect(source).toContain('agentName={bannerExecution.agentName}');
        expect(source).toContain('modelId={bannerExecution.modelId}');
        expect(source).not.toContain('const readOnlyPromptBanner = parentSessionTarget ? (');
    });

    test('desktop composer keeps a page-background fade above the input', () => {
        expect(source).toContain('const DesktopComposerEdgeFade');
        expect(source).toContain('bg-gradient-to-t from-[var(--surface-background)] to-transparent');
        expect(source).toContain('{!isMobile && !isDesktopExpandedInput ? <DesktopComposerEdgeFade /> : null}');
        expect(source.match(/<DesktopComposerEdgeFade \/>/g)).toHaveLength(2);
    });

    test('legend scroller dataset restores the transcript scroll-shadow mask', () => {
        expect(source).toContain("scrollShadow: 'true'");
        expect(source).toContain("orientation: 'vertical'");
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
