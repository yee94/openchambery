/**
 * Coalesce end-anchor measure corrections into one height + scrollTop write.
 *
 * virtual-core calls `scrollToFn` synchronously for every `resizeItem` while
 * `wasAtEnd` (and for above-fold first measures). Opening a conversation measures
 * N rows in one commit → N scrollTop writes → Layout + ScrollLayer thrash that
 * reads as load-time jitter. Queue the latest target and flush once per task
 * (microtask) so a full measure wave becomes one paint.
 */

export type VirtualizerScrollToOptions = {
    adjustments?: number;
    behavior?: ScrollBehavior;
};

export type VirtualizerScrollToInstance = {
    getTotalSize: () => number;
    scrollElement: Element | null;
};

export type CoalesceVirtualizerScrollToState = {
    scheduled: boolean;
    target: number | null;
    totalSize: number | null;
    sizeElement: HTMLElement | null;
};

export const createCoalesceVirtualizerScrollToState = (): CoalesceVirtualizerScrollToState => ({
    scheduled: false,
    target: null,
    totalSize: null,
    sizeElement: null,
});

export const resolveVirtualizerScrollTarget = (
    offset: number,
    options?: VirtualizerScrollToOptions,
): number => offset + (options?.adjustments ?? 0);

/**
 * @returns true when the write was scheduled for a later microtask; false when
 * it was applied immediately (smooth scroll or no queueMicrotask).
 */
export const scheduleCoalescedVirtualizerScrollTo = (
    state: CoalesceVirtualizerScrollToState,
    input: {
        offset: number;
        options?: VirtualizerScrollToOptions;
        instance: VirtualizerScrollToInstance;
        sizeElement: HTMLElement | null;
        /** Immediate writer used for smooth behavior and environments without microtasks. */
        writeNow: (offset: number, options: VirtualizerScrollToOptions | undefined, instance: VirtualizerScrollToInstance) => void;
        schedule?: (flush: () => void) => void;
    },
): boolean => {
    if (input.options?.behavior === 'smooth') {
        input.writeNow(input.offset, input.options, input.instance);
        return false;
    }

    state.target = resolveVirtualizerScrollTarget(input.offset, input.options);
    state.totalSize = input.instance.getTotalSize();
    state.sizeElement = input.sizeElement;

    if (state.scheduled) {
        return true;
    }

    const schedule = input.schedule ?? ((flush) => {
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(flush);
            return;
        }
        flush();
    });

    state.scheduled = true;
    schedule(() => {
        state.scheduled = false;
        const target = state.target;
        const totalSize = state.totalSize;
        const sizeElement = state.sizeElement;
        state.target = null;
        state.totalSize = null;
        state.sizeElement = null;
        if (target === null || totalSize === null) {
            return;
        }
        if (sizeElement) {
            sizeElement.style.height = `${totalSize}px`;
        }
        const element = input.instance.scrollElement as HTMLElement | null;
        if (element && typeof element.scrollTo === 'function') {
            element.scrollTo({ top: target });
            return;
        }
        if (element) {
            element.scrollTop = target;
        }
    });
    return true;
};
