/**
 * Mobile composer swap: expanded card exits downward, compact pill rises.
 *
 * Progress 0 = expanded, 1 = compact. Motion is paint-only (transform/opacity).
 *
 * Model:
 * - Follow is relative: each user-owned scroll frame moves progress by its own
 *   travel (FULL_RANGE px = 0…1), so the composer tracks the finger from
 *   wherever it rests — at the bottom or far up the transcript — and a frame
 *   can never jump progress against the direction of travel.
 * - Travel toward the bottom also scales progress by the remaining distance,
 *   so a compact composer always reaches expanded exactly at the live edge.
 * - While a finger is down the machine only follows; commit happens after the
 *   gesture ends (touchend / scrollend / scroll idle) and picks the final form
 *   from the last travel direction: a small move in one direction commits that
 *   way, a stationary release falls back to the 0.5 midpoint.
 * - A single frame that crosses most of the range (fling) snaps with the CSS
 *   transition instead of cutting straight to the endpoint.
 * - After a compact snap, the hook may suppress return-follow briefly while iOS
 *   momentum settles; later vertical gesture intent releases that suppression.
 */

/** Half-range px; travel that moves progress across the commit midpoint. */
export const COMPOSER_SWAP_FOLLOW_RANGE_PX = 40;
/** Travel that moves progress across the whole 0…1 range. */
export const COMPOSER_SWAP_FULL_RANGE_PX = COMPOSER_SWAP_FOLLOW_RANGE_PX * 2;
/** Treat this near-bottom band as "at the bottom" for expand recovery. */
export const COMPOSER_SWAP_NOISE_PX = 2;
export const COMPOSER_SWAP_COMMIT_THRESHOLD = 0.5;
export const COMPOSER_SWAP_SNAP_MS = 240;
export const COMPOSER_SWAP_IDLE_MS = 120;
/** After landing compact, ignore return-follow this long (momentum settle). */
export const COMPOSER_SWAP_COMPACT_SETTLE_MS = 320;
/**
 * Continuous travel in one direction that makes the release commit follow that
 * direction instead of the 0.5 midpoint. Small reading wiggles stay below it.
 */
export const COMPOSER_SWAP_INTENT_TRAVEL_PX = 16;
/** Travel older than this at commit time no longer counts as release intent. */
export const COMPOSER_SWAP_INTENT_WINDOW_MS = 250;
/** Vertical finger travel before a touch claims scroll ownership (tap jitter). */
export const COMPOSER_SWAP_TOUCH_SLOP_PX = 6;
/** One frame moving progress at least this far snaps with the transition. */
const COMPOSER_SWAP_FLING_STEP = 0.5;
/**
 * Vertical touchmove intent carries into scroll geometry for this long after
 * lift-off. The hook isolates content/viewport size changes and anchoring frames
 * from this window. Sized to outlast fling momentum after the finger lifts.
 */
export const COMPOSER_SWAP_USER_SCROLL_WINDOW_MS = 1200;
export const COMPOSER_SWAP_CSS_VAR = '--yuri-mobile-composer-swap';
/**
 * Native iOS accessory fade (Changes / TODO / queue). Independent of swap:
 * swap can rest expanded hundreds of px from the live edge (toward-bottom
 * travel). Those rows have no background, so they must stay hidden
 * until the viewport is actually at the bottom.
 *
 * 0 = at the bottom (visible), 1 = ≥ FOLLOW_RANGE away (hidden). Approaching
 * the edge stays hidden until the true bottom (NOISE); leaving fades out over
 * the first FOLLOW_RANGE px so a 1px nudge does not flash them on or off.
 */
export const NATIVE_COMPOSER_DOCK_CSS_VAR = '--yuri-native-composer-dock';

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

/**
 * Relative follow. A frame moves progress by its own travel, never by absolute
 * distance, so it cannot jump against the finger. Travel toward the bottom
 * also scales by the remaining distance so progress lands on 0 exactly at the
 * live edge — the composer never arrives at the bottom half-collapsed.
 */
const quantize = (value: number): number => Math.round(clamp(value, 0, 1) * 1000) / 1000;

const followProgress = (
    progress: number,
    previousDistance: number,
    distance: number,
): number => {
    const travel = distance - previousDistance;
    if (travel >= 0) {
        return quantize(progress + travel / COMPOSER_SWAP_FULL_RANGE_PX);
    }
    if (distance <= COMPOSER_SWAP_NOISE_PX) return 0;
    const toward = progress + travel / COMPOSER_SWAP_FULL_RANGE_PX;
    const edgeBound = progress * (distance / previousDistance);
    return quantize(Math.min(toward, edgeBound));
};

const restFor = (progress: number, fallback: ComposerSwapRest): ComposerSwapRest => {
    if (progress >= 1) return 'compact';
    if (progress <= 0) return 'expanded';
    return fallback;
};

/**
 * Apply one scroll frame. `suppressReturn` is a short post-compact settle
 * window from the hook — not a permanent latch — so repeat expand↔compact
 * cycles keep working.
 *
 * User-owned scrolling can interrupt an in-flight snap: the frame continues
 * from the snap target. Program-owned frames preserve the current phase and
 * leave timer completion in charge.
 */
export const applyComposerSwapScroll = (
    state: ComposerSwapState,
    distanceFromBottom: number,
    options: {
        /** Distance on the previous frame; omitted means no travel (baseline). */
        previousDistance?: number | null;
        suppressReturn?: boolean;
        /**
         * False when the geometry moved without a gesture behind it (streaming
         * growth, the list gliding back to the end). Such frames preserve the
         * exact current swap state.
         */
        userDriven?: boolean;
    } = {},
): ComposerSwapState => {
    if (state.pinned) return state;
    if (options.userDriven === false) return state;

    const distance = Math.max(0, distanceFromBottom);
    const previousDistance = options.previousDistance == null
        ? distance
        : Math.max(0, options.previousDistance);
    const base = state.phase === 'snapping'
        ? settle(state, {
            phase: 'rest',
            rest: state.rest,
            progress: state.rest === 'compact' ? 1 : 0,
        })
        : state;

    // The live edge always owns the expanded endpoint.
    if (distance <= COMPOSER_SWAP_NOISE_PX) {
        return settle(base, { phase: 'rest', rest: 'expanded', progress: 0 });
    }

    if (options.suppressReturn && base.rest === 'compact' && distance < previousDistance) {
        return settle(base, { phase: 'rest', rest: 'compact', progress: 1 });
    }

    const progress = followProgress(base.progress, previousDistance, distance);
    // Momentum after a fling keeps pushing past the snap target; let the
    // running transition finish instead of cutting it to rest.
    if (state.phase === 'snapping' && progress === base.progress) return state;
    if (progress === base.progress) return base;

    // A fling crosses most of the range in one frame. Cutting straight to the
    // endpoint reads as a flash; let the snap transition carry it instead.
    if (Math.abs(progress - base.progress) >= COMPOSER_SWAP_FLING_STEP
        && (progress >= 1 || progress <= 0)) {
        return settle(base, {
            phase: 'snapping',
            rest: progress >= 1 ? 'compact' : 'expanded',
            progress,
        });
    }

    if (progress >= 1 || progress <= 0) {
        return settle(base, { phase: 'rest', rest: restFor(progress, base.rest), progress });
    }
    return settle(base, { phase: 'tracking', rest: base.rest, progress });
};

/**
 * Final form after the gesture. A deliberate last move commits in its own
 * direction — the user releasing mid-way while still pushing must not spring
 * back. Without a recent direction the 0.5 midpoint decides.
 */
export const resolveComposerSwapCommit = (
    state: ComposerSwapState,
    direction: 'compact' | 'expanded' | null = null,
): ComposerSwapRest => {
    if (state.pinned) return 'expanded';
    if (direction) return direction;
    return state.progress >= COMPOSER_SWAP_COMMIT_THRESHOLD ? 'compact' : 'expanded';
};

export const applyComposerSwapCommit = (
    state: ComposerSwapState,
    direction: 'compact' | 'expanded' | null = null,
): ComposerSwapState => {
    if (state.pinned) {
        return settle(state, {
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
            pinned: true,
        });
    }
    if (state.phase === 'snapping') return state;
    const rest = resolveComposerSwapCommit(state, direction);
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

/**
 * Measured web composer occupancy (card + Changes / TODO / queue + safe area),
 * published on the root. The root resolves `--yuri-chat-foot-inset` from it,
 * so the transcript reserves exactly the chrome it sits under instead of a
 * fixed guess. Swap motion is transform-only and never changes it. Hidden
 * (0-height) measurements keep the last value instead of clearing it.
 */
export const MOBILE_COMPOSER_OCCUPANCY_CSS_VAR = '--yuri-mobile-composer-occupancy';

export const publishMobileComposerOccupancy = (root: HTMLElement, height: number): string | null => {
    if (!(height > 0)) return null;
    const next = `${Math.round(height)}px`;
    if (root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR) !== next) {
        root.style.setProperty(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR, next);
    }
    return next;
};

/** Clears only the value this publisher wrote; another composer may own it now. */
export const clearMobileComposerOccupancy = (root: HTMLElement, written: string | null): void => {
    if (written === null) return;
    if (root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR) !== written) return;
    root.style.removeProperty(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR);
};

/**
 * Per-frame motion variables live on the overlay foot, not the scope: an
 * inherited custom property written on the scope restyles the whole transcript
 * on every tracking frame. Phase/rest attributes stay on the scope; they change
 * only at lifecycle edges.
 */
export const resolveComposerSwapMotionTarget = (scope: HTMLElement): HTMLElement => {
    for (const child of scope.children) {
        if (child instanceof HTMLElement && child.classList.contains('yuri-mobile-composer-foot--overlay')
            && !child.classList.contains('invisible')) {
            return child;
        }
    }
    return scope;
};

export const clearComposerSwap = (scope: HTMLElement, motionTarget: HTMLElement = scope): void => {
    for (const element of new Set([scope, motionTarget])) {
        element.style.removeProperty(COMPOSER_SWAP_CSS_VAR);
        element.style.removeProperty(NATIVE_COMPOSER_DOCK_CSS_VAR);
    }
    delete scope.dataset.yuriComposerSwapPhase;
    delete scope.dataset.yuriComposerSwapRest;
    delete scope.dataset.yuriNativeComposerDock;
};

export const publishNativeComposerDock = (
    scope: HTMLElement,
    distanceFromBottom: number,
    last?: { progress: string; rest: string },
    motionTarget: HTMLElement = scope,
): { progress: string; rest: string } => {
    const resolved = resolveNativeComposerDock(
        distanceFromBottom,
        last?.rest === 'bottom' ? 'bottom' : 'away',
    );
    const progress = String(resolved.progress);
    const rest = resolved.rest;
    if (last?.progress !== progress) {
        motionTarget.style.setProperty(NATIVE_COMPOSER_DOCK_CSS_VAR, progress);
    }
    if (last?.rest !== rest) {
        scope.dataset.yuriNativeComposerDock = rest;
    }
    return { progress, rest };
};

export const publishComposerSwap = (
    scope: HTMLElement,
    state: ComposerSwapState,
    last?: { progress: string; phase: string; rest: string },
    motionTarget: HTMLElement = scope,
): { progress: string; phase: string; rest: string } => {
    const progress = String(state.progress);
    const phase = state.phase;
    const rest = state.rest;
    // Phase first so snapping can arm the CSS transition before progress jumps.
    if (last?.phase !== phase) {
        scope.dataset.yuriComposerSwapPhase = phase;
        if (phase === 'snapping' && last && last.phase !== 'snapping') {
            void motionTarget.offsetWidth;
        }
    }
    if (last?.progress !== progress) {
        motionTarget.style.setProperty(COMPOSER_SWAP_CSS_VAR, progress);
    }
    if (last?.rest !== rest) {
        scope.dataset.yuriComposerSwapRest = rest;
    }
    return { progress, phase, rest };
};
