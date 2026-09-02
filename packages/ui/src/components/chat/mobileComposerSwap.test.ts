import { describe, expect, test } from 'vitest';

import {
    COMPOSER_SWAP_CSS_VAR,
    COMPOSER_SWAP_FOLLOW_RANGE_PX,
    COMPOSER_SWAP_FULL_RANGE_PX,
    COMPOSER_SWAP_NOISE_PX,
    NATIVE_COMPOSER_DOCK_CSS_VAR,
    applyComposerSwapCommit,
    applyComposerSwapForce,
    applyComposerSwapPin,
    applyComposerSwapScroll,
    applyComposerSwapSnapDone,
    createComposerSwapState,
    distanceFromBottomOf,
    clearComposerSwap,
    nativeComposerDockProgressFromDistance,
    publishComposerSwap,
    publishNativeComposerDock,
    resolveComposerSwapCommit,
    resolveNativeComposerDock,
} from './mobileComposerSwap';

describe('mobileComposerSwap', () => {
    test('upward scroll starts tracking immediately — no dead zone', () => {
        let state = createComposerSwapState();
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_NOISE_PX + 1);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeGreaterThan(0);
        expect(state.progress).toBeLessThan(0.5);

        state = applyComposerSwapScroll(state, 10);
        expect(state.progress).toBe(0.125);

        state = applyComposerSwapScroll(state, 20);
        expect(state.progress).toBe(0.25);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBe(0.5);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX * 10);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('commit after the gesture picks the final form from progress', () => {
        const short = applyComposerSwapScroll(createComposerSwapState(), 20);
        expect(short.progress).toBe(0.25);
        expect(resolveComposerSwapCommit(short)).toBe('expanded');
        expect(applyComposerSwapCommit(short)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });

        const past = applyComposerSwapScroll(createComposerSwapState(), 60);
        expect(past.progress).toBe(0.75);
        expect(resolveComposerSwapCommit(past)).toBe('compact');
        expect(applyComposerSwapCommit(past)).toMatchObject({
            phase: 'snapping',
            rest: 'compact',
            progress: 1,
        });
    });

    test('repeat expand↔compact cycles keep working without a permanent latch', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        // Temporary suppress (hook settle window) holds compact near the bottom.
        state = applyComposerSwapScroll(state, 30, {
            suppressReturn: true,
        });
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        // After settle ends, return follow works again.
        state = applyComposerSwapScroll(state, 30);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeCloseTo(0.375);

        state = applyComposerSwapScroll(state, 0);
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });

        // Second cycle from expanded still tracks and commits.
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX + 20);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        state = applyComposerSwapScroll(state, 10);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeCloseTo(0.125);
        state = applyComposerSwapSnapDone(applyComposerSwapCommit(state));
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('scroll can interrupt an in-flight snap so the machine cannot stick', () => {
        let state = applyComposerSwapCommit(
            applyComposerSwapScroll(createComposerSwapState(), 60),
        );
        expect(state.phase).toBe('snapping');
        expect(state.rest).toBe('compact');

        // User keeps scrolling while snapping — interrupt; rest stays the snap
        // target and compact return-follow can continue instead of freezing.
        state = applyComposerSwapScroll(state, 10);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeCloseTo(0.125);

        // A later expanded cycle still works after the interrupt.
        state = applyComposerSwapSnapDone(applyComposerSwapForce(state, 'expanded'));
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX * 2);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('pin forces expanded', () => {
        let state = applyComposerSwapScroll(createComposerSwapState(), 20);
        expect(state.progress).toBe(0.25);
        state = applyComposerSwapPin(state, true);
        expect(state).toMatchObject({
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
            pinned: true,
        });
        state = applyComposerSwapScroll(state, 80);
        expect(state.progress).toBe(0);
    });

    test('publish writes CSS var and arms snap phase before progress jump', () => {
        const writes: string[] = [];
        const scope = {
            style: {
                setProperty(name: string, value: string) {
                    writes.push(`${name}:${value}`);
                },
            },
            dataset: {} as DOMStringMap,
        } as HTMLElement;

        const first = publishComposerSwap(scope, createComposerSwapState());
        expect(writes).toEqual([`${COMPOSER_SWAP_CSS_VAR}:0`]);

        const tracking = applyComposerSwapScroll(
            createComposerSwapState(),
            COMPOSER_SWAP_FOLLOW_RANGE_PX,
        );
        expect(tracking.phase).toBe('tracking');
        expect(tracking.progress).toBe(0.5);
        publishComposerSwap(scope, tracking, first);
        expect(scope.dataset.ocComposerSwapPhase).toBe('tracking');

        const order: string[] = [];
        const dataset: Record<string, string> = {};
        const orderedScope = {
            style: {
                setProperty(_name: string, value: string) {
                    order.push(`progress:${value}`);
                },
            },
            dataset: new Proxy(dataset, {
                set(target, key, value) {
                    if (typeof key === 'string') order.push(`${key}:${String(value)}`);
                    target[String(key)] = String(value);
                    return true;
                },
            }),
            get offsetWidth() {
                order.push('flush');
                return 0;
            },
        } as unknown as HTMLElement;

        const published = publishComposerSwap(orderedScope, tracking);
        order.length = 0;
        publishComposerSwap(orderedScope, applyComposerSwapCommit(tracking), published);
        expect(order[0]).toBe('ocComposerSwapPhase:snapping');
        expect(order.indexOf('flush')).toBeLessThan(order.indexOf('progress:1'));
    });

    test('clearComposerSwap drops leftover inline swap so a reused draft root cannot stay compact', () => {
        const scope = document.createElement('div');
        const compact = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        publishComposerSwap(scope, compact);
        expect(scope.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('1');
        expect(scope.dataset.ocComposerSwapRest).toBe('compact');

        clearComposerSwap(scope);
        expect(scope.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('');
        expect(scope.dataset.ocComposerSwapPhase).toBeUndefined();
        expect(scope.dataset.ocComposerSwapRest).toBeUndefined();
    });

    test('force expand works from compact', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        state = applyComposerSwapForce(state, 'expanded');
        expect(state).toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });
    });

    test('compact return follow maps the full range', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX / 2);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBe(0.5);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FULL_RANGE_PX);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_NOISE_PX);
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('travel toward the bottom reveals a compact composer outside the follow band', () => {
        const compact = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );

        // Far from the bottom, distance alone keeps it compact forever.
        expect(applyComposerSwapScroll(compact, 600)).toMatchObject({
            phase: 'rest',
            rest: 'compact',
            progress: 1,
        });

        // Same distance, but the viewport is travelling back toward the edge.
        const revealed = applyComposerSwapScroll(compact, 600, { towardBottom: true });
        expect(revealed).toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });

        // The post-compact settle window still wins so momentum cannot bounce.
        expect(applyComposerSwapScroll(compact, 600, {
            towardBottom: true,
            suppressReturn: true,
        })).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('geometry with no gesture behind it cannot start a collapse', () => {
        const expanded = createComposerSwapState();

        // Streaming growth pushes the end far away for several frames.
        expect(applyComposerSwapScroll(expanded, 300, { userDriven: false })).toMatchObject({
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
        });

        // The same distance from a real gesture still collapses.
        expect(applyComposerSwapScroll(expanded, 300, { userDriven: true })).toMatchObject({
            phase: 'rest',
            rest: 'compact',
            progress: 1,
        });
    });

    test('inside the follow band the tuned proportional return is unchanged', () => {
        const compact = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        const inBand = applyComposerSwapScroll(compact, 10, { towardBottom: true });
        expect(inBand.phase).toBe('tracking');
        expect(inBand.progress).toBeCloseTo(0.125);
    });

    test('holdExpanded keeps a revealed composer up until the user scrolls away', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapScroll(
                applyComposerSwapSnapDone(applyComposerSwapForce(createComposerSwapState(), 'compact')),
                600,
                { towardBottom: true },
            ),
        );
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });

        // Still hundreds of px from the bottom: absolute-distance follow would
        // collapse it on the next event of the same downward gesture.
        state = applyComposerSwapScroll(state, 560, { towardBottom: true, holdExpanded: true });
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });

        // Once the hold is released, upward distance collapses it as before.
        state = applyComposerSwapScroll(state, 560);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('native accessory dock follows distance, not swap rest', () => {
        expect(nativeComposerDockProgressFromDistance(0)).toBe(0);
        expect(nativeComposerDockProgressFromDistance(-4)).toBe(0);
        expect(nativeComposerDockProgressFromDistance(COMPOSER_SWAP_FOLLOW_RANGE_PX)).toBe(0.5);
        expect(nativeComposerDockProgressFromDistance(COMPOSER_SWAP_FULL_RANGE_PX)).toBe(1);
        expect(nativeComposerDockProgressFromDistance(COMPOSER_SWAP_FULL_RANGE_PX * 4)).toBe(1);

        expect(resolveNativeComposerDock(20, 'away')).toMatchObject({ progress: 1, rest: 'away' });
        expect(resolveNativeComposerDock(COMPOSER_SWAP_NOISE_PX, 'away')).toMatchObject({
            progress: 0,
            rest: 'bottom',
        });
        expect(resolveNativeComposerDock(20, 'bottom')).toMatchObject({
            progress: 0.25,
            rest: 'bottom',
        });
        expect(resolveNativeComposerDock(COMPOSER_SWAP_FOLLOW_RANGE_PX, 'bottom')).toMatchObject({
            progress: 1,
            rest: 'away',
        });

        const scope = document.createElement('div');
        const far = publishNativeComposerDock(scope, 260);
        expect(far).toMatchObject({ progress: '1', rest: 'away' });
        expect(scope.style.getPropertyValue(NATIVE_COMPOSER_DOCK_CSS_VAR)).toBe('1');
        expect(scope.dataset.ocNativeComposerDock).toBe('away');

        // Approaching the edge stays hidden — a short downward scroll must not
        // fade the strip in before the viewport is actually at the bottom.
        const approaching = publishNativeComposerDock(scope, 20, far);
        expect(approaching).toMatchObject({ progress: '1', rest: 'away' });

        const arrived = publishNativeComposerDock(scope, 0, approaching);
        expect(arrived).toMatchObject({ progress: '0', rest: 'bottom' });

        const leaving = publishNativeComposerDock(scope, 20, arrived);
        expect(leaving).toMatchObject({ progress: '0.25', rest: 'bottom' });

        const gone = publishNativeComposerDock(scope, COMPOSER_SWAP_FOLLOW_RANGE_PX, leaving);
        expect(gone).toMatchObject({ progress: '1', rest: 'away' });

        clearComposerSwap(scope);
        expect(scope.style.getPropertyValue(NATIVE_COMPOSER_DOCK_CSS_VAR)).toBe('');
        expect(scope.dataset.ocNativeComposerDock).toBeUndefined();
    });

    test('distanceFromBottomOf never goes negative', () => {
        expect(distanceFromBottomOf({
            scrollHeight: 100,
            scrollTop: 80,
            clientHeight: 40,
        })).toBe(0);
        expect(distanceFromBottomOf({
            scrollHeight: 200,
            scrollTop: 40,
            clientHeight: 80,
        })).toBe(80);
    });
});
