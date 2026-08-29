import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Sending a message must occupy the remaining viewport after the last turn
 * and park that row near the top. Occupancy is a trailing list item with a
 * fixed size, not a minHeight on the turn and not a footer — collapse and
 * shrink measurement keep writing the row's natural height. jsdom gives
 * this list a zero-sized viewport, so the wiring is read rather than run.
 */
describe('TimelineList new-turn anchor contracts', () => {
    const source = readFileSync(join(here, 'TimelineList.tsx'), 'utf8');
    const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf8');

    test('end maintenance stands down while a turn is reserved', () => {
        expect(source).toContain(
            'if ((anchoredEndSpace && !parkReleased) || !followEnabled || historyAnchor) return false;',
        );
    });

    test('occupancy is a fixed-size list item after the turn, not a minHeight on it', () => {
        expect(source).toContain('resolveReplyReserveUpdate({');
        expect(source).toContain('data-oc-reply-reserve="true"');
        expect(source).toContain("kind: TIMELINE_REPLY_RESERVE_KIND");
        expect(source).toContain('getFixedItemSize={getReplyReserveFixedSize}');
        expect(source).toContain('viewportHeight: viewportHeightRef.current');
        expect(source).toContain('viewportHeight: resolvedViewportHeight');
        expect(source).toContain('resolveShrunkItemSizeUpdate(known, size.height)');
        expect(source).not.toContain('minHeight: reserveMinHeight');
        expect(source).not.toContain('style={reserveMinHeight');
        expect(source).not.toContain('TimelineReplyReserveFooter');
        expect(source).not.toContain('anchoredEndSpace: anchoredEndSpaceForList');
        expect(source).not.toContain('onReady: handleAnchoredEndSpaceReady');
    });

    test('overflow or a collapse that would reopen the spacer drops the reserve', () => {
        expect(source).toContain("applyAnchoredTurnScroll('reveal')");
        expect(source).toContain('releaseAnchoredTurnPark(currentReserveId)');
        expect(source).toContain('releaseAnchoredTurnPark(space.anchorId ?? entries[space.anchorIndex]?.key ?? null)');
        expect(source).toContain('isReplyReserveOverflowing(metrics.turnHeight, usableViewportHeightRef.current)');
    });

    test('the list parks once per send, then only reveals overflow', () => {
        expect(source).toContain("applyAnchoredTurnScroll('park')");
        expect(source).toContain("applyAnchoredTurnScroll('reveal')");
        expect(source).toContain('if (parkedReserveIdRef.current === reserveId) return;');
        expect(source).toContain('if (parkedReserveIdRef.current === currentReserveId) return;');
        expect(source).toContain('getAnchoredTurnMetrics({');
        expect(source).toContain('metrics.scrollDeltaToRevealEnd < 1');
    });

    test('reveal does not fight a user who has taken over the viewport', () => {
        const revealFn = source.indexOf("const applyAnchoredTurnScroll = useEvent((mode: 'park' | 'reveal')");
        expect(revealFn).toBeGreaterThan(-1);
        const body = source.slice(revealFn, revealFn + 1800);
        expect(body).toContain('if (!followEnabledRef.current) return false;');
        expect(body).toContain("if (mode === 'park')");
    });

    test('parking the just-sent row glides instead of jumping', () => {
        const park = source.indexOf("if (mode === 'park')");
        expect(park).toBeGreaterThan(-1);
        const parkBody = source.slice(park, source.indexOf('if (!followEnabledRef.current)', park));
        expect(parkBody).toContain('scrollToOffset({ offset, animated })');
        expect(parkBody).not.toContain('animated: false');
        expect(parkBody).toContain("prefers-reduced-motion: reduce");
        expect(source).toContain('if (now < parkAnimatingUntilRef.current) return false;');
    });

    test('MessageList latches the send onto a reserved turn before paint', () => {
        expect(messageListSource).toContain('resolveConsumedSendMessageId({');
        expect(messageListSource).toContain('resolveNextAnchoredUserMessageId({');
        expect(messageListSource).toContain('resolveChatListAnchoredEndSpace(');
        expect(messageListSource).toContain('anchoredUserMessageId={nextAnchorId}');
        expect(messageListSource).toContain('setAnchoredUserMessageId(nextAnchorId)');
        expect(messageListSource).toContain('readTimelineParkEndOffset');
        expect(messageListSource).toContain('onAnchoredTurnParkReleased={onAnchoredTurnParkReleased}');
        expect(messageListSource).toContain('enableSendPark = true');
        expect(messageListSource).toContain('showLiveStatusRow={isNewest}');
        expect(messageListSource).toContain('<StatusRowContainer />');
        expect(messageListSource).toContain('clearConsumedUserSendAnimation(sessionKey)');
    });

    test('the optimistic insert marks the send before the user row exists', () => {
        const actions = readFileSync(join(here, '../../sync/session-actions.ts'), 'utf8');
        const mark = actions.indexOf('markPendingUserSendAnimation(input.sessionId)');
        const insert = actions.indexOf('optimisticInsertUserMessage({');
        expect(mark).toBeGreaterThan(-1);
        expect(insert).toBeGreaterThan(mark);
    });

    test('the context-panel transcript does not own the send-park latch', () => {
        const contextPanel = readFileSync(join(here, '../layout/ContextPanelSessionTranscript.tsx'), 'utf8');
        expect(contextPanel).toContain('enableSendPark={false}');
    });

    test('jump-to-latest keeps the reserved hole and returns to the parked edge', () => {
        const handle = messageListSource.indexOf('scrollToBottom: () => {');
        expect(handle).toBeGreaterThan(-1);
        const body = messageListSource.slice(handle, handle + 900);
        expect(body).toContain('readTimelineParkEndOffset(resolveScrollContainer())');
        expect(body).toContain('scrollToOffset({');
        expect(body).toContain('offset: parkOffset');
        expect(body).not.toContain('clearConsumedUserSendAnimation(sessionKey)');
        expect(body).not.toContain('pendingScrollToEndAfterAnchorClearRef');
        expect(body).not.toContain('setAnchoredUserMessageId(null)');
    });

    test('the parked edge is the chrome-aware middle window', () => {
        expect(source).toContain('endInsetHeight: footerHeight');
        expect(source).toContain('resolveParkAnchorOffset(headerHeight)');
        expect(source).toContain('data-oc-timeline-header');
        expect(source).toContain('data-oc-timeline-footer');
        expect(source).toContain('writeTimelineParkEndOffset');
        expect(source).toContain('resolveTimelineDistanceFromParkedEnd');
        expect(source).toContain('state.scroll > parkOffset + 1');
    });

    test('an unmeasured viewport does not wipe a seeded reserve', () => {
        expect(source).toContain('} else if (usableViewportHeight <= 0) {');
        expect(source).not.toContain('parkReleased || usableViewportHeight <= 0');
    });
});
