/**
 * Mobile composer swap: expanded card exits downward, compact pill rises.
 *
 * Progress 0 = expanded, 1 = compact. Motion is paint-only (transform/opacity).
 *
 * Model:
 * - Any upward scroll from expanded starts tracking immediately (no dead zone).
 * - The first half follows scroll; finishing that half (or idle past it) snaps the rest.
 * - After a compact snap, the hook may suppress return-follow briefly so iOS
 *   momentum cannot bounce straight back — that is NOT a permanent latch.
 */

/** Gesture delta that maps to the follow half (progress 0 → 0.5). */
export const COMPOSER_SWAP_FOLLOW_RANGE_PX = 40;
/** Treat this near-bottom band as "at the bottom" for expand recovery. */
export const COMPOSER_SWAP_NOISE_PX = 2;
export const COMPOSER_SWAP_COMMIT_THRESHOLD = 0.5;
export const COMPOSER_SWAP_SNAP_MS = 240;
export const COMPOSER_SWAP_IDLE_MS = 120;
/** After landing compact, ignore return-follow this long (momentum settle). */
export const COMPOSER_SWAP_COMPACT_SETTLE_MS = 320;
export const COMPOSER_SWAP_CSS_VAR = '--oc-mobile-composer-swap';

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

/** Expanded follow: distance 0…FOLLOW → progress 0…0.5. Starts immediately. */
const followFromExpanded = (distanceFromBottom: number): number => (
    clamp(distanceFromBottom / COMPOSER_SWAP_FOLLOW_RANGE_PX, 0, 0.5)
);

/**
 * Compact return follow: only the last FOLLOW px toward the bottom map
 * progress 1…0.5. Farther away stays fully compact.
 */
const followFromCompact = (distanceFromBottom: number): number => {
    if (distanceFromBottom >= COMPOSER_SWAP_FOLLOW_RANGE_PX) return 1;
    return 0.5 + 0.5 * (distanceFromBottom / COMPOSER_SWAP_FOLLOW_RANGE_PX);
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
    options: { suppressReturn?: boolean } = {},
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
        return settle(base, {
            phase: 'tracking',
            rest: 'expanded',
            progress: followFromExpanded(distance),
        });
    }

    // Compact rest — near the true bottom expands immediately.
    if (distance <= COMPOSER_SWAP_NOISE_PX) {
        return settle(base, {
            phase: 'snapping',
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

/** True when the follow half is finished and the remaining snap should run now. */
export const shouldComposerSwapAutoCommit = (state: ComposerSwapState): boolean => {
    if (state.pinned || state.phase !== 'tracking') return false;
    if (state.rest === 'expanded') {
        return state.progress >= COMPOSER_SWAP_COMMIT_THRESHOLD;
    }
    return state.progress <= COMPOSER_SWAP_COMMIT_THRESHOLD;
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

export const clearComposerSwap = (scope: HTMLElement): void => {
    scope.style.removeProperty(COMPOSER_SWAP_CSS_VAR);
    delete scope.dataset.ocComposerSwapPhase;
    delete scope.dataset.ocComposerSwapRest;
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
