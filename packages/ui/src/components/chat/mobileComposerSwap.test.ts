import { describe, expect, test } from 'vitest';

import {
    COMPOSER_SWAP_COMMIT_THRESHOLD,
    COMPOSER_SWAP_CSS_VAR,
    COMPOSER_SWAP_FOLLOW_RANGE_PX,
    COMPOSER_SWAP_NOISE_PX,
    applyComposerSwapCommit,
    applyComposerSwapForce,
    applyComposerSwapPin,
    applyComposerSwapScroll,
    applyComposerSwapSnapDone,
    createComposerSwapState,
    distanceFromBottomOf,
    publishComposerSwap,
    resolveComposerSwapCommit,
    shouldComposerSwapAutoCommit,
} from './mobileComposerSwap';

describe('mobileComposerSwap', () => {
    test('upward scroll starts tracking immediately — no dead zone', () => {
        let state = createComposerSwapState();
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_NOISE_PX + 1);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeGreaterThan(0);
        expect(state.progress).toBeLessThan(0.5);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX / 4);
        expect(state.progress).toBe(0.25);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX / 2);
        expect(state.progress).toBe(0.5);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX);
        expect(state.progress).toBe(0.5);

        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX * 10);
        expect(state.progress).toBe(0.5);
    });

    test('idle before the follow half snaps back; finishing the half auto-commits compact', () => {
        const short = applyComposerSwapScroll(createComposerSwapState(), COMPOSER_SWAP_FOLLOW_RANGE_PX / 4);
        expect(short.progress).toBe(0.25);
        expect(shouldComposerSwapAutoCommit(short)).toBe(false);
        expect(resolveComposerSwapCommit(short)).toBe('expanded');
        expect(applyComposerSwapCommit(short)).toMatchObject({
            phase: 'snapping',
            rest: 'expanded',
            progress: 0,
        });

        const half = applyComposerSwapScroll(createComposerSwapState(), COMPOSER_SWAP_FOLLOW_RANGE_PX);
        expect(half.progress).toBe(COMPOSER_SWAP_COMMIT_THRESHOLD);
        expect(shouldComposerSwapAutoCommit(half)).toBe(true);
        expect(resolveComposerSwapCommit(half)).toBe('compact');
        expect(applyComposerSwapCommit(half)).toMatchObject({
            phase: 'snapping',
            rest: 'compact',
            progress: 1,
        });
    });

    test('repeat expand↔compact cycles keep working without a permanent latch', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapCommit(
                applyComposerSwapScroll(createComposerSwapState(), COMPOSER_SWAP_FOLLOW_RANGE_PX),
            ),
        );
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        // Temporary suppress (hook settle window) holds compact near the bottom.
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX / 2, {
            suppressReturn: true,
        });
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });

        // After settle ends, return follow works again.
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX / 2);
        expect(state.phase).toBe('tracking');
        expect(state.progress).toBeCloseTo(0.75);

        state = applyComposerSwapScroll(state, 0);
        expect(state).toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });
        state = applyComposerSwapSnapDone(state);

        // Second cycle from expanded still tracks and commits.
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX);
        expect(shouldComposerSwapAutoCommit(state)).toBe(true);
        state = applyComposerSwapSnapDone(applyComposerSwapCommit(state));
        expect(state).toMatchObject({ phase: 'rest', rest: 'compact', progress: 1 });
    });

    test('scroll can interrupt an in-flight snap so the machine cannot stick', () => {
        let state = applyComposerSwapCommit(
            applyComposerSwapScroll(createComposerSwapState(), COMPOSER_SWAP_FOLLOW_RANGE_PX),
        );
        expect(state.phase).toBe('snapping');
        expect(state.rest).toBe('compact');

        // User keeps scrolling while snapping — interrupt; rest stays the snap
        // target and compact return-follow can continue instead of freezing.
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX / 4);
        expect(state.phase).toBe('tracking');
        expect(state.rest).toBe('compact');
        expect(state.progress).toBeCloseTo(0.625);

        // A later expanded cycle still works after the interrupt.
        state = applyComposerSwapSnapDone(applyComposerSwapForce(state, 'expanded'));
        state = applyComposerSwapScroll(state, COMPOSER_SWAP_FOLLOW_RANGE_PX);
        expect(shouldComposerSwapAutoCommit(state)).toBe(true);
    });

    test('pin forces expanded', () => {
        let state = applyComposerSwapScroll(createComposerSwapState(), 20);
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

    test('force expand works from compact', () => {
        let state = applyComposerSwapSnapDone(
            applyComposerSwapForce(createComposerSwapState(), 'compact'),
        );
        state = applyComposerSwapForce(state, 'expanded');
        expect(state).toMatchObject({ phase: 'snapping', rest: 'expanded', progress: 0 });
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
