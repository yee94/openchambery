// Empty tail the transcript keeps below its newest message.
//
// Not the same thing as `--oc-chat-foot-inset`, which reserves the bottom
// chrome the Composer actually occupies (input, queued messages, changes /
// tasks strip). This spacer sits on top of that reservation and is the
// breathing room itself: without it the newest message ends exactly where the
// chrome begins, so a streaming reply reads as clipped against the bottom of
// the screen and there is nothing left to scroll up into.
//
// The same height is the "still at the bottom" band on the auto-follow engine:
// it is exactly how far above the live edge the viewport can rest while the
// reader is looking at empty space, which is what re-arms follow and hides the
// scroll-to-bottom control. Keeping both readings on one constant is the
// point — a spacer that outgrows its band strands the pill on screen at rest.
// The legend timeline measures distance from its own live edge and owns
// tighter bands instead; see ./timelineScrollAnchoring.

/** Desktop tail, as a percentage of the scroll viewport. */
const CHAT_TAIL_SPACER_DESKTOP_VH = 10;

export const CHAT_TAIL_SPACER_DESKTOP_HEIGHT = `${CHAT_TAIL_SPACER_DESKTOP_VH}vh`;

/**
 * Mobile tail.
 *
 * A phone gets a fixed height rather than the desktop fraction: the visual
 * viewport moves with the keyboard and the browser chrome, and a tail that
 * breathes with it changes the at-bottom band under the reader.
 */
export const CHAT_TAIL_SPACER_MOBILE_PX = 80;

export const CHAT_TAIL_SPACER_MOBILE_HEIGHT = `${CHAT_TAIL_SPACER_MOBILE_PX}px`;

/**
 * Mobile tail for a list that derives its own content size.
 *
 * The auto-follow engine gets the chrome reservation from CSS padding on its
 * scroll content (`.chat-scroll-foot-inset`). The legend timeline reads
 * padding from style objects only, so its scroll math cannot see that class —
 * the reservation has to be part of this measured spacer instead.
 */
export const CHAT_TAIL_SPACER_MOBILE_WITH_FOOT_INSET_HEIGHT =
    `calc(${CHAT_TAIL_SPACER_MOBILE_HEIGHT} + var(--oc-chat-foot-inset))`;

/**
 * Distance from the live edge that still counts as being at the bottom.
 *
 * Mirrors the tail height so the whole empty tail reads as the bottom. An
 * unmeasured viewport falls back to a desktop-sized band rather than 0, which
 * would report a pinned transcript as scrolled away.
 */
export const resolveChatBottomZoneThresholdPx = (
    isMobile: boolean,
    clientHeight: number,
): number => {
    if (isMobile) return CHAT_TAIL_SPACER_MOBILE_PX;
    if (clientHeight <= 0) return 96;
    return Math.max(48, clientHeight * (CHAT_TAIL_SPACER_DESKTOP_VH / 100));
};
