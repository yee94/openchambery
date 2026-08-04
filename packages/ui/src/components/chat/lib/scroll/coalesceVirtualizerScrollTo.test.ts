import { describe, expect, test } from 'bun:test';

import {
    createCoalesceVirtualizerScrollToState,
    resolveVirtualizerScrollTarget,
    scheduleCoalescedVirtualizerScrollTo,
} from './coalesceVirtualizerScrollTo';

describe('coalesceVirtualizerScrollTo', () => {
    test('resolves offset plus adjustments', () => {
        expect(resolveVirtualizerScrollTarget(100, { adjustments: 20 })).toBe(120);
        expect(resolveVirtualizerScrollTarget(100)).toBe(100);
    });

    test('collapses a measure wave into one height and scroll write', () => {
        const state = createCoalesceVirtualizerScrollToState();
        const writes: Array<{ top: number; height: string }> = [];
        const sizeElement = { style: { height: '' } } as HTMLElement;
        const scrollElement = {
            scrollTo: (init: ScrollToOptions) => {
                writes.push({ top: Number(init.top), height: sizeElement.style.height });
            },
        } as unknown as HTMLElement;

        let totalSize = 0;
        const instance = {
            getTotalSize: () => totalSize,
            scrollElement,
        };

        const flushes: Array<() => void> = [];
        const schedule = (flush: () => void) => {
            flushes.push(flush);
        };

        const wave = [
            { offset: 1000, adjustments: -40, total: 300 },
            { offset: 1010, adjustments: -40, total: 260 },
            { offset: 1020, adjustments: -40, total: 220 },
        ];
        for (const step of wave) {
            totalSize = step.total;
            const scheduled = scheduleCoalescedVirtualizerScrollTo(state, {
                offset: step.offset,
                options: { adjustments: step.adjustments },
                instance,
                sizeElement,
                writeNow: () => {
                    throw new Error('writeNow should not run for non-smooth scroll');
                },
                schedule,
            });
            expect(scheduled).toBe(true);
        }

        expect(writes).toEqual([]);
        expect(flushes).toHaveLength(1);
        flushes[0]?.();
        // Last scheduled target wins: offset 1020 + (-40) = 980, total 220.
        expect(writes).toEqual([{ top: 980, height: '220px' }]);
    });

    test('writes smooth scrolls immediately', () => {
        const state = createCoalesceVirtualizerScrollToState();
        const immediate: number[] = [];
        scheduleCoalescedVirtualizerScrollTo(state, {
            offset: 50,
            options: { behavior: 'smooth', adjustments: 5 },
            instance: { getTotalSize: () => 100, scrollElement: null },
            sizeElement: null,
            writeNow: (offset, options) => {
                immediate.push(offset + (options?.adjustments ?? 0));
            },
            schedule: () => {
                throw new Error('smooth path must not schedule');
            },
        });
        expect(immediate).toEqual([55]);
    });
});
