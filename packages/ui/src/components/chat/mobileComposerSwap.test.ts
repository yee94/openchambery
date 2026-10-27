import { describe, expect, test } from 'vitest';

import {
    COMPOSER_SWAP_CSS_VAR,
    COMPOSER_SWAP_FOLLOW_RANGE_PX,
    COMPOSER_SWAP_FULL_RANGE_PX,
    COMPOSER_SWAP_NOISE_PX,
    MOBILE_COMPOSER_OCCUPANCY_CSS_VAR,
    NATIVE_COMPOSER_DOCK_CSS_VAR,
    applyComposerSwapCommit,
    applyComposerSwapForce,
    applyComposerSwapPin,
    applyComposerSwapScroll,
    applyComposerSwapSnapDone,
    createComposerSwapState,
    distanceFromBottomOf,
    clearComposerSwap,
    clearMobileComposerOccupancy,
    nativeComposerDockProgressFromDistance,
    publishComposerSwap,
    publishMobileComposerOccupancy,
    publishNativeComposerDock,
    resolveComposerSwapCommit,
    resolveComposerSwapMotionTarget,
    resolveNativeComposerDock,
    type ComposerSwapState,
} from './mobileComposerSwap';

describe('mobileComposerSwap', () => {
    const compactRest = () => applyComposerSwapSnapDone(
        applyComposerSwapForce(createComposerSwapState(), 'compact'),
    );
    /** Feed a run of user frames, each from the previous distance. */
    const travel = (
        state: ComposerSwapState,
        distances: number[],
        options: { suppressReturn?: boolean; userDriven?: boolean } = {},
    ): ComposerSwapState => {
        let next = state;
        for (let index = 1; index < distances.length; index += 1) {
            next = applyComposerSwapScroll(next, distances[index], {
                ...options,
                previousDistance: distances[index - 1],
            });
        }
        return next;
    };

    test('upward travel tracks the finger from the bottom — no dead zone', () => {
        let state = travel(createComposerSwapState(), [0, COMPOSER_SWAP_NOISE_PX + 1]);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeGreaterThan(0);

        state = travel(state, [COMPOSER_SWAP_NOISE_PX + 1, 10]);
        expect(state.progress).toBeCloseTo(0.125, 2);
        state = travel(state, [10, COMPOSER_SWAP_FOLLOW_RANGE_PX]);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeCloseTo(0.5, 2);
        state = travel(state, [COMPOSER_SWAP_FOLLOW_RANGE_PX, 60, COMPOSER_SWAP_FULL_RANGE_PX]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
        state = travel(state, [COMPOSER_SWAP_FULL_RANGE_PX, COMPOSER_SWAP_FULL_RANGE_PX * 10]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('follow is relative, so a gesture far from the bottom still tracks', () => {
        // Expanded far up the transcript (e.g. after a reveal): progress moves by
        // travel, not by absolute distance, so it cannot jump to compact.
        const expanded = createComposerSwapState();
        const started = travel(expanded, [600, 620]);
        expect(started).toMatchObject({ phase: 'tracking', rest: 'expanded', progress: 0.25 });

        // A frame with no baseline is a no-op instead of an absolute jump.
        expect(applyComposerSwapScroll(expanded, 600)).toBe(expanded);
    });

    test('travel toward the bottom reveals compact proportionally far from the edge', () => {
        let state = travel(compactRest(), [600, 570]);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeCloseTo(0.625);

        state = travel(state, [570, 550, 530, 520]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('toward-bottom travel lands expanded exactly at the live edge', () => {
        // Near the edge the remaining-distance bound wins over raw travel.
        let state = travel(compactRest(), [20, 10]);
        expect(state.progress).toBe(0.5);
        state = travel(state, [10, 5]);
        expect(state.progress).toBe(0.25);
        state = travel(state, [5, COMPOSER_SWAP_NOISE_PX]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('release commits in the last travel direction, else at the midpoint', () => {
        const short = travel(createComposerSwapState(), [0, 20]);
        expect(short.progress).toBe(0.25);
        expect(resolveComposerSwapCommit(short)).toBe('expanded');
        expect(resolveComposerSwapCommit(short, 'compact')).toBe('compact');
        expect(applyComposerSwapCommit(short, 'compact')).toMatchObject({
            phase: 'snapping',
            rest: 'compact',
            progress: 1,
        });

        const past = travel(createComposerSwapState(), [0, 60]);
        expect(past.progress).toBe(0.75);
        expect(resolveComposerSwapCommit(past)).toBe('compact');
        expect(applyComposerSwapCommit(past, 'expanded')).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });

        expect(resolveComposerSwapCommit(applyComposerSwapPin(past, true), 'compact')).toBe('expanded');
    });

    test('a fling frame crossing most of the range snaps instead of cutting', () => {
        expect(travel(createComposerSwapState(), [0, 300])).toMatchObject({
            phase: 'snapping',
            rest: 'compact',
            progress: 1,
        });
        expect(travel(compactRest(), [600, 500])).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });

        // Momentum continuing past the snap target leaves the transition running.
        const snapping = travel(createComposerSwapState(), [0, 300]);
        expect(travel(snapping, [300, 400])).toBe(snapping);
    });

    test('repeat expand↔compact cycles keep working without a permanent latch', () => {
        let state = compactRest();

        // Temporary suppress (hook settle window) holds compact on return travel.
        state = travel(state, [40, 30], { suppressReturn: true });
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        // After settle ends, return follow works again.
        state = travel(state, [40, 30]);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeCloseTo(0.75);

        state = travel(state, [30, 15, COMPOSER_SWAP_NOISE_PX]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });

        state = travel(state, [0, 30, 60, COMPOSER_SWAP_FULL_RANGE_PX + 20]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        state = travel(state, [COMPOSER_SWAP_FULL_RANGE_PX + 20, COMPOSER_SWAP_FULL_RANGE_PX]);
        expect(state.phase).toBe('tracking');
        state = applyComposerSwapSnapDone(applyComposerSwapCommit(state, 'expanded'));
        expect(state).toMatchObject({ phase: 'rest', rest: 'expanded', progress: 0 });
    });

    test('scroll can interrupt an in-flight snap so the machine cannot stick', () => {
        let state = applyComposerSwapCommit(travel(createComposerSwapState(), [0, 60]));
        expect(state).toMatchObject({ phase: 'snapping', rest: 'compact' });

        // User reverses while snapping: continue from the snap target.
        state = travel(state, [60, 50]);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeLessThan(1);

        state = applyComposerSwapSnapDone(applyComposerSwapForce(state, 'expanded'));
        state = travel(state, [50, 70, 90, 110, 130]);
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('pin forces expanded', () => {
        let state = travel(createComposerSwapState(), [0, 20]);
        expect(state.progress).toBe(0.25);
        state = applyComposerSwapPin(state, true);
        expect(state).toMatchObject({
            phase: 'rest',
            rest: 'expanded',
            progress: 0,
            pinned: true,
        });
        state = travel(state, [20, 80]);
        expect(state.progress).toBe(0);
    });

    test('publish writes progress on the motion target and arms snap phase first', () => {
        const scope = document.createElement('div');
        const foot = document.createElement('div');
        foot.className = 'yuri-mobile-composer-foot--overlay';
        const hidden = document.createElement('div');
        hidden.className = 'yuri-mobile-composer-foot--overlay invisible';
        scope.append(hidden, foot);
        expect(resolveComposerSwapMotionTarget(scope)).toBe(foot);
        expect(resolveComposerSwapMotionTarget(document.createElement('div')).tagName).toBe('DIV');

        const tracking = travel(createComposerSwapState(), [0, COMPOSER_SWAP_FOLLOW_RANGE_PX]);
        publishComposerSwap(scope, tracking, undefined, foot);
        expect(foot.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('0.5');
        expect(scope.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('');
        expect(scope.dataset.yuriComposerSwapPhase).toBe('tracking');

        const order: string[] = [];
        const dataset: Record<string, string> = {};
        const orderedScope = {
            style: { setProperty() {} },
            dataset: new Proxy(dataset, {
                set(target, key, value) {
                    if (typeof key === 'string') order.push(`${key}:${String(value)}`);
                    target[String(key)] = String(value);
                    return true;
                },
            }),
        } as unknown as HTMLElement;
        const orderedTarget = {
            style: {
                setProperty(_name: string, value: string) {
                    order.push(`progress:${value}`);
                },
            },
            get offsetWidth() {
                order.push('flush');
                return 0;
            },
        } as unknown as HTMLElement;

        const published = publishComposerSwap(orderedScope, tracking, undefined, orderedTarget);
        order.length = 0;
        publishComposerSwap(orderedScope, applyComposerSwapCommit(tracking), published, orderedTarget);
        expect(order[0]).toBe('yuriComposerSwapPhase:snapping');
        expect(order.indexOf('flush')).toBeLessThan(order.indexOf('progress:1'));
    });

    test('clearComposerSwap drops leftover inline swap so a reused draft root cannot stay compact', () => {
        const scope = document.createElement('div');
        const foot = document.createElement('div');
        publishComposerSwap(scope, compactRest(), undefined, foot);
        expect(foot.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('1');
        expect(scope.dataset.yuriComposerSwapRest).toBe('compact');

        clearComposerSwap(scope, foot);
        expect(foot.style.getPropertyValue(COMPOSER_SWAP_CSS_VAR)).toBe('');
        expect(scope.dataset.yuriComposerSwapPhase).toBeUndefined();
        expect(scope.dataset.yuriComposerSwapRest).toBeUndefined();
    });

    test('force expand works from compact', () => {
        expect(applyComposerSwapForce(compactRest(), 'expanded')).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });
    });

    test('geometry with no gesture behind it cannot start a collapse', () => {
        const expanded = createComposerSwapState();
        expect(travel(expanded, [0, 300], { userDriven: false })).toBe(expanded);
        expect(travel(expanded, [0, 300], { userDriven: true })).toMatchObject({
            rest: 'compact',
            progress: 1,
        });
    });

    test('non-user compensation never moves a compact composer', () => {
        const compact = compactRest();
        expect(travel(compact, [200, COMPOSER_SWAP_FOLLOW_RANGE_PX], { userDriven: false })).toBe(compact);
        expect(travel(compact, [200, 0], { userDriven: false })).toBe(compact);
    });

    test('non-user frames preserve tracking and snapping exactly', () => {
        const tracking = travel(createComposerSwapState(), [0, 30]);
        expect(tracking.phase).toBe('tracking');
        expect(travel(tracking, [30, 70], { userDriven: false })).toBe(tracking);

        const snapping = applyComposerSwapCommit(tracking);
        expect(snapping.phase).toBe('snapping');
        expect(travel(snapping, [30, 0], { userDriven: false })).toBe(snapping);
    });

    test('occupancy publish writes rounded height and clears only its own value', () => {
        const root = document.createElement('div');
        expect(publishMobileComposerOccupancy(root, 0)).toBeNull();
        expect(root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR)).toBe('');

        const written = publishMobileComposerOccupancy(root, 154.6);
        expect(written).toBe('155px');
        expect(root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR)).toBe('155px');

        root.style.setProperty(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR, '200px');
        clearMobileComposerOccupancy(root, written);
        expect(root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR)).toBe('200px');
        clearMobileComposerOccupancy(root, '200px');
        expect(root.style.getPropertyValue(MOBILE_COMPOSER_OCCUPANCY_CSS_VAR)).toBe('');
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
        expect(scope.dataset.yuriNativeComposerDock).toBe('away');

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
        expect(scope.dataset.yuriNativeComposerDock).toBeUndefined();
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
