/**
 * Mobile composer swap: expanded card exits downward, compact pill rises.
 *
 * Progress 0 = expanded, 1 = compact. Motion is paint-only (transform/opacity).
 *
 * Model:
 * - Any upward scroll from expanded starts tracking immediately (no dead zone).
 * - Follow maps the full FULL_RANGE px to progress 0…1 so a held drag never
 *   parks at the 0.5 handoff where both layers are invisible.
 * - While a finger is down the machine only follows; commit happens after the
 *   gesture ends (touchend / scrollend / scroll idle) and picks the final form
 *   from progress vs the commit threshold.
 * - After a compact snap, the hook may suppress return-follow briefly so iOS
 *   momentum cannot bounce straight back — that is NOT a permanent latch.
 * - Distance alone cannot decide the compact→expanded direction once the
 *   composer may be expanded far from the bottom, so the hook supplies travel
 *   direction: `towardBottom` reveals from outside the follow band, and
 *   `holdExpanded` keeps that reveal alive until the user scrolls up again.
 */

/** Half-range px; commit threshold sits at this distance from the bottom. */
export const COMPOSER_SWAP_FOLLOW_RANGE_PX = 40;
/** Full follow map: distance 0…FULL → progress 0…1. */
export const COMPOSER_SWAP_FULL_RANGE_PX = COMPOSER_SWAP_FOLLOW_RANGE_PX * 2;
/** Treat this near-bottom band as "at the bottom" for expand recovery. */
export const COMPOSER_SWAP_NOISE_PX = 2;
export const COMPOSER_SWAP_COMMIT_THRESHOLD = 0.5;
export const COMPOSER_SWAP_SNAP_MS = 240;
export const COMPOSER_SWAP_IDLE_MS = 120;
/** After landing compact, ignore return-follow this long (momentum settle). */
export const COMPOSER_SWAP_COMPACT_SETTLE_MS = 320;
/**
 * Downward travel that reveals a compact composer from outside the follow band.
 * Accumulated across events so a slow deliberate scroll qualifies too; iOS
 * top rubber-band spring-back is excluded by the hook, not by this distance.
 */
export const COMPOSER_SWAP_REVEAL_TRAVEL_PX = 24;
/**
 * Scroll geometry only carries user intent within this long of a touch. Content
 * growth and the list's own animated end maintenance move the end away from the
 * viewport for many frames with no gesture behind them; without this window the
 * transcript would collapse the composer on its own streaming output. Sized to
 * outlast fling momentum after the finger lifts.
 */
export const COMPOSER_SWAP_USER_SCROLL_WINDOW_MS = 1200;
export const COMPOSER_SWAP_CSS_VAR = '--oc-mobile-composer-swap';
/**
 * Native iOS accessory fade (Changes / TODO / queue). Independent of swap:
 * swap can rest expanded hundreds of px from the live edge (downward reveal /
 * holdExpanded). Those rows have no background, so they must stay hidden
 * until the viewport is actually at the bottom.
 *
 * 0 = at the bottom (visible), 1 = ≥ FOLLOW_RANGE away (hidden). Approaching
 * the edge stays hidden until the true bottom (NOISE); leaving fades out over
 * the first FOLLOW_RANGE px so a 1px nudge does not flash them on or off.
 */
export const NATIVE_COMPOSER_DOCK_CSS_VAR = '--oc-native-composer-dock';

export type NativeComposerDockRest = 'bottom' | 'away';

export type ComposerSwapRest = 'expanded' | 'compact';
export type ComposerSwapPhase = 'rest' | 'tracking' | 'snapping';

export type ComposerSwapState = {
    phase: ComposerSwapPhase;
    rest: ComposerSwapRest;
    progress: number;
    pinned: boolean;
};

export const createComposerSwapState = (): ComposerSwapState => ({
    phase: 'rest',
    rest: 'expanded',
    progress: 0,
    pinned: false,
});

const clamp = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

const sameState = (left: ComposerSwapState, right: ComposerSwapState): boolean => (
    left.phase === right.phase
    && left.rest === right.rest
    && left.progress === right.progress
    && left.pinned === right.pinned
);

const settle = (
    state: ComposerSwapState,
    next: Partial<ComposerSwapState> & Pick<ComposerSwapState, 'phase' | 'rest' | 'progress'>,
): ComposerSwapState => {
    const resolved: ComposerSwapState = {
        phase: next.phase,
        rest: next.rest,
        progress: next.progress,
        pinned: next.pinned ?? state.pinned,
    };
    return sameState(state, resolved) ? state : resolved;
};

export const distanceFromBottomOf = (geometry: {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
}): number => Math.max(0, geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight);

export const applyComposerSwapPin = (
    state: ComposerSwapState,
    pinned: boolean,
): ComposerSwapState => {
    if (pinned) {
        return settle(state, {
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
            pinned: true,
        });
    }
    if (!state.pinned) return state;
    return settle(state, {
        phase: 'rest',
        rest: 'expanded',
        progress: 0,
        pinned: false,
    });
};

export const applyComposerSwapForce = (
    state: ComposerSwapState,
    rest: ComposerSwapRest,
): ComposerSwapState => {
    if (state.pinned && rest === 'compact') return state;
    const progress = rest === 'compact' ? 1 : 0;
    if (state.phase === 'rest' && state.rest === rest && state.progress === progress) {
        return state;
    }
    return settle(state, {
        phase: 'snapping',
        rest,
        progress,
    });
};

/** Expanded follow: distance 0…FULL maps progress 0…1. Starts immediately. */
const followFromExpanded = (distanceFromBottom: number): number => (
    clamp(distanceFromBottom / COMPOSER_SWAP_FULL_RANGE_PX, 0, 1)
);

/**
 * Compact return follow: the last FULL px toward the bottom map progress
 * 1…0. Farther away stays fully compact.
 */
const followFromCompact = (distanceFromBottom: number): number => {
    if (distanceFromBottom >= COMPOSER_SWAP_FULL_RANGE_PX) return 1;
    return clamp(distanceFromBottom / COMPOSER_SWAP_FULL_RANGE_PX, 0, 1);
};

/**
 * Apply scroll. `suppressReturn` is a short post-compact settle window from the
 * hook — not a permanent latch — so repeat expand↔compact cycles keep working.
 *
 * Snapping can be interrupted: a new scroll target cancels the in-flight snap
 * so the machine cannot stick in `snapping` across later gestures.
 */
export const applyComposerSwapScroll = (
    state: ComposerSwapState,
    distanceFromBottom: number,
    options: {
        suppressReturn?: boolean;
        /** The viewport is travelling toward the live edge (hook-measured). */
        towardBottom?: boolean;
        /** A scroll reveal owns the expanded endpoint; ignore absolute distance. */
        holdExpanded?: boolean;
        /**
         * False when the geometry moved without a gesture behind it (streaming
         * growth, the list gliding back to the end). Such frames may not start
         * a collapse; arriving at the true bottom still expands.
         */
        userDriven?: boolean;
    } = {},
): ComposerSwapState => {
    if (state.pinned) return state;

    const distance = Math.max(0, distanceFromBottom);
    const base = state.phase === 'snapping'
        ? settle(state, {
            phase: 'rest',
            rest: state.rest,
            progress: state.rest === 'compact' ? 1 : 0,
        })
        : state;

    if (base.rest === 'expanded') {
        if (distance <= COMPOSER_SWAP_NOISE_PX) {
            return settle(base, {
                phase: 'rest',
                rest: 'expanded',
                progress: 0,
            });
        }
        // Expanded used to imply "at the bottom", so any distance meant the user
        // had scrolled up. Two things break that. A scroll reveal leaves the
        // composer expanded hundreds of px from the live edge, and absolute-
        // distance follow would collapse it again on the very next event of the
        // same downward gesture. Streaming growth does the same without any
        // gesture at all: the tail appends, the end jumps away from the viewport
        // and the list glides back over several frames — every one of those
        // frames reads as a large distance and used to flash the composer shut.
        if (options.holdExpanded || options.userDriven === false) {
            return settle(base, {
                phase: 'rest',
                rest: 'expanded',
                progress: 0,
            });
        }
        const progress = followFromExpanded(distance);
        // Full follow reached the compact end — settle without a snap animation.
        if (progress >= 1) {
            return settle(base, {
                phase: 'rest',
                rest: 'compact',
                progress: 1,
            });
        }
        return settle(base, {
            phase: 'tracking',
            rest: 'expanded',
            progress,
        });
    }

    // Compact rest — reaching the true bottom completes expansion via follow.
    if (distance <= COMPOSER_SWAP_NOISE_PX) {
        return settle(base, {
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
        });
    }

    if (options.suppressReturn) {
        return settle(base, {
            phase: 'rest',
            rest: 'compact',
            progress: 1,
        });
    }

    // Outside the follow band the composer used to stay compact no matter how
    // far the user scrolled back down — it only returned once the bottom band
    // was in reach. Travel toward the live edge reveals it there instead; inside
    // the band the tuned proportional follow below still owns the motion.
    if (options.towardBottom && distance >= COMPOSER_SWAP_FULL_RANGE_PX) {
        return settle(base, {
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });
    }

    const progress = followFromCompact(distance);
    if (progress >= 1) {
        return settle(base, {
            phase: 'rest',
            rest: 'compact',
            progress: 1,
        });
    }
    return settle(base, {
        phase: 'tracking',
        rest: 'compact',
        progress,
    });
};

export const resolveComposerSwapCommit = (state: ComposerSwapState): ComposerSwapRest => {
    if (state.pinned) return 'expanded';
    if (state.rest === 'expanded') {
        return state.progress >= COMPOSER_SWAP_COMMIT_THRESHOLD ? 'compact' : 'expanded';
    }
    return state.progress <= COMPOSER_SWAP_COMMIT_THRESHOLD ? 'expanded' : 'compact';
};

export const applyComposerSwapCommit = (state: ComposerSwapState): ComposerSwapState => {
    if (state.pinned) {
        return settle(state, {
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
            pinned: true,
        });
    }
    if (state.phase === 'snapping') return state;
    const rest = resolveComposerSwapCommit(state);
    const progress = rest === 'compact' ? 1 : 0;
    if (state.phase === 'rest' && state.rest === rest && state.progress === progress) {
        return state;
    }
    return settle(state, {
        phase: 'snapping',
        rest,
        progress,
    });
};

export const applyComposerSwapSnapDone = (state: ComposerSwapState): ComposerSwapState => {
    if (state.phase !== 'snapping') return state;
    return settle(state, {
        phase: 'rest',
        rest: state.rest,
        progress: state.rest === 'compact' ? 1 : 0,
    });
};

export const nativeComposerDockProgressFromDistance = (distanceFromBottom: number): number => (
    clamp(Math.max(0, distanceFromBottom) / COMPOSER_SWAP_FULL_RANGE_PX, 0, 1)
);

/**
 * Latch the accessory strip so approaching the bottom does not fade it in
 * until the viewport is actually there, and leaving does not hide it on the
 * first pixel — only after FOLLOW_RANGE of upward travel.
 */
export const resolveNativeComposerDock = (
    distanceFromBottom: number,
    previous: NativeComposerDockRest = 'away',
): { progress: number; rest: NativeComposerDockRest } => {
    const distance = Math.max(0, distanceFromBottom);
    if (distance <= COMPOSER_SWAP_NOISE_PX) {
        return { progress: 0, rest: 'bottom' };
    }
    if (previous === 'away' || distance >= COMPOSER_SWAP_FOLLOW_RANGE_PX) {
        return { progress: 1, rest: 'away' };
    }
    return {
        progress: nativeComposerDockProgressFromDistance(distance),
        rest: 'bottom',
    };
};

export const clearComposerSwap = (scope: HTMLElement): void => {
    scope.style.removeProperty(COMPOSER_SWAP_CSS_VAR);
    scope.style.removeProperty(NATIVE_COMPOSER_DOCK_CSS_VAR);
    delete scope.dataset.ocComposerSwapPhase;
    delete scope.dataset.ocComposerSwapRest;
    delete scope.dataset.ocNativeComposerDock;
};

export const publishNativeComposerDock = (
    scope: HTMLElement,
    distanceFromBottom: number,
    last?: { progress: string; rest: string },
): { progress: string; rest: string } => {
    const resolved = resolveNativeComposerDock(
        distanceFromBottom,
        last?.rest === 'bottom' ? 'bottom' : 'away',
    );
    const progress = String(resolved.progress);
    const rest = resolved.rest;
    if (last?.progress !== progress) {
        scope.style.setProperty(NATIVE_COMPOSER_DOCK_CSS_VAR, progress);
    }
    if (last?.rest !== rest) {
        scope.dataset.ocNativeComposerDock = rest;
    }
    return { progress, rest };
};

export const publishComposerSwap = (
    scope: HTMLElement,
    state: ComposerSwapState,
    last?: { progress: string; phase: string; rest: string },
): { progress: string; phase: string; rest: string } => {
    const progress = String(state.progress);
    const phase = state.phase;
    const rest = state.rest;
    // Phase first so snapping can arm the CSS transition before progress jumps.
    if (last?.phase !== phase) {
        scope.dataset.ocComposerSwapPhase = phase;
        if (phase === 'snapping' && last && last.phase !== 'snapping') {
            void scope.offsetWidth;
        }
    }
    if (last?.progress !== progress) {
        scope.style.setProperty(COMPOSER_SWAP_CSS_VAR, progress);
    }
    if (last?.rest !== rest) {
        scope.dataset.ocComposerSwapRest = rest;
    }
    return { progress, phase, rest };
};
