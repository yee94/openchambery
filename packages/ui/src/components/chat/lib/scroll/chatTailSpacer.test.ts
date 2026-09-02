import { describe, expect, test } from 'vitest';

import {
    CHAT_TAIL_SPACER_DESKTOP_HEIGHT,
    CHAT_TAIL_SPACER_MOBILE_HEIGHT,
    CHAT_TAIL_SPACER_MOBILE_PX,
    CHAT_TAIL_SPACER_MOBILE_WITH_FOOT_INSET_HEIGHT,
    resolveChatBottomZoneThresholdPx,
} from './chatTailSpacer';

/**
 * The tail is the breathing room under the newest message, on top of the
 * `--oc-chat-foot-inset` chrome reservation. A mobile tail sized like a
 * scroll threshold rather than like empty space left a streaming reply
 * pressed against the queued-message strip with nothing to scroll up into.
 */
describe('chat tail spacer', () => {
    test('the mobile tail is large enough to read as empty space', () => {
        expect(CHAT_TAIL_SPACER_MOBILE_PX).toBeGreaterThanOrEqual(72);
        expect(CHAT_TAIL_SPACER_MOBILE_HEIGHT).toBe(`${CHAT_TAIL_SPACER_MOBILE_PX}px`);
    });

    test('a list that measures its own footer carries the chrome reservation too', () => {
        expect(CHAT_TAIL_SPACER_MOBILE_WITH_FOOT_INSET_HEIGHT)
            .toBe(`calc(${CHAT_TAIL_SPACER_MOBILE_HEIGHT} + var(--oc-chat-foot-inset))`);
        // The auto-follow engine gets that reservation from CSS padding
        // instead, so its tail must stay the breathing room alone.
        expect(CHAT_TAIL_SPACER_MOBILE_HEIGHT).not.toContain('--oc-chat-foot-inset');
        expect(CHAT_TAIL_SPACER_DESKTOP_HEIGHT).toBe('10vh');
    });

    test('the at-bottom band is the mobile tail height', () => {
        expect(resolveChatBottomZoneThresholdPx(true, 800)).toBe(CHAT_TAIL_SPACER_MOBILE_PX);
        expect(resolveChatBottomZoneThresholdPx(true, 0)).toBe(CHAT_TAIL_SPACER_MOBILE_PX);
    });

    test('the desktop band tracks the viewport fraction with a floor', () => {
        expect(resolveChatBottomZoneThresholdPx(false, 800)).toBe(80);
        expect(resolveChatBottomZoneThresholdPx(false, 200)).toBe(48);
    });

    test('an unmeasured desktop viewport does not report a pinned transcript as scrolled away', () => {
        expect(resolveChatBottomZoneThresholdPx(false, 0)).toBeGreaterThan(0);
    });
});
