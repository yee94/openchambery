import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createHistoryViewportAnchorKeeper } from './historyViewportAnchorKeeper';

type Rect = {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
    x: number;
    y: number;
};

const asDomRect = (partial: Partial<Rect>): DOMRect => {
    const top = partial.top ?? 0;
    const height = partial.height ?? 40;
    const left = partial.left ?? 0;
    const width = partial.width ?? 100;
    return {
        top,
        bottom: partial.bottom ?? top + height,
        left,
        right: partial.right ?? left + width,
        width,
        height,
        x: partial.x ?? left,
        y: partial.y ?? top,
        toJSON: () => ({}),
    } as DOMRect;
};

const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('createHistoryViewportAnchorKeeper', () => {
    let container: HTMLElement;
    let msgA: HTMLElement;
    let msgB: HTMLElement;
    let msgC: HTMLElement;
    let aboveSpacer: HTMLElement;

    const rects = new Map<Element, Rect>();

    const setRect = (el: Element, rect: Partial<Rect>) => {
        rects.set(el, {
            top: rect.top ?? 0,
            bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 40),
            left: rect.left ?? 0,
            right: rect.right ?? 100,
            width: rect.width ?? 100,
            height: rect.height ?? 40,
            x: rect.x ?? 0,
            y: rect.y ?? (rect.top ?? 0),
        });
    };

    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });

        container = document.createElement('div');
        Object.defineProperty(container, 'scrollTop', {
            configurable: true,
            writable: true,
            value: 200,
        });

        aboveSpacer = document.createElement('div');
        msgA = document.createElement('div');
        msgA.dataset.messageId = 'msg-a';
        msgB = document.createElement('div');
        msgB.dataset.messageId = 'msg-b';
        msgC = document.createElement('div');
        msgC.dataset.messageId = 'msg-c';

        container.append(aboveSpacer, msgA, msgB, msgC);
        document.body.appendChild(container);

        // Container viewport top at 0; msg-b sits 80px below the viewport top
        // (the armed expected offset).
        setRect(container, { top: 0, height: 400, bottom: 400 });
        setRect(aboveSpacer, { top: -120, height: 100, bottom: -20 });
        setRect(msgA, { top: -20, height: 100, bottom: 80 });
        setRect(msgB, { top: 80, height: 100, bottom: 180 });
        setRect(msgC, { top: 180, height: 100, bottom: 280 });

        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ) {
            const stored = rects.get(this);
            if (stored) return asDomRect(stored);
            return asDomRect({});
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('grows content above the anchor → scrollTop compensates in the mutation microtask', async () => {
        const keeper = createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
            quiesceMs: 600,
            maxLifetimeMs: 6000,
        });

        const scrollBefore = container.scrollTop;

        // Simulate prepend growth: everything shifts down by 50px in viewport
        // coords (content inserted above), which would drift the anchor unless
        // scrollTop is corrected.
        setRect(aboveSpacer, { top: -70, height: 150, bottom: 80 });
        setRect(msgA, { top: 30, height: 100, bottom: 130 });
        setRect(msgB, { top: 130, height: 100, bottom: 230 });
        setRect(msgC, { top: 230, height: 100, bottom: 330 });
        aboveSpacer.style.height = '150px';

        await flushMicrotasks();

        expect(container.scrollTop).toBe(scrollBefore + 50);
        // After scrollTop += 50, live viewport math would put msg-b back at 80;
        // we assert the compensation write itself.
        expect(msgB.getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(130);

        keeper.dispose();
    });

    test('grows content below the anchor → no compensation', async () => {
        const keeper = createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
        });

        const scrollBefore = container.scrollTop;

        // Only content below msg-b grows; msg-b viewport offset stays 80.
        setRect(msgC, { top: 180, height: 200, bottom: 380 });
        msgC.style.height = '200px';

        await flushMicrotasks();

        expect(container.scrollTop).toBe(scrollBefore);

        keeper.dispose();
    });

    test('user scroll rebases expected offset; later above growth only compensates the mutation', async () => {
        const keeper = createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
        });

        // User scrolls: update live rects, then scrollTop + dispatch scroll.
        setRect(aboveSpacer, { top: -160, height: 100, bottom: -60 });
        setRect(msgA, { top: -60, height: 100, bottom: 40 });
        setRect(msgB, { top: 40, height: 100, bottom: 140 });
        setRect(msgC, { top: 140, height: 100, bottom: 240 });
        container.scrollTop = 240;
        container.dispatchEvent(new Event('scroll'));

        // Above content grows by 30px after rebase.
        const scrollAfterRebase = container.scrollTop;
        setRect(aboveSpacer, { top: -130, height: 130, bottom: 0 });
        setRect(msgA, { top: -30, height: 100, bottom: 70 });
        setRect(msgB, { top: 70, height: 100, bottom: 170 });
        setRect(msgC, { top: 170, height: 100, bottom: 270 });
        aboveSpacer.style.height = '130px';

        await flushMicrotasks();

        expect(container.scrollTop).toBe(scrollAfterRebase + 30);

        keeper.dispose();
    });

    test('quiesce: auto-disposes after quiet period; later mutations do not compensate', async () => {
        createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
            quiesceMs: 600,
            maxLifetimeMs: 6000,
        });

        vi.advanceTimersByTime(600);

        const scrollBefore = container.scrollTop;
        setRect(msgA, { top: 30, height: 100, bottom: 130 });
        setRect(msgB, { top: 130, height: 100, bottom: 230 });
        aboveSpacer.style.height = '150px';

        await flushMicrotasks();

        expect(container.scrollTop).toBe(scrollBefore);
    });

    test('removed anchor swaps to the first visible [data-message-id]', async () => {
        const keeper = createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
        });

        msgB.remove();
        // After removal, msg-c is the first with bottom > container top.
        setRect(msgA, { top: -40, height: 40, bottom: 0 });
        setRect(msgC, { top: 60, height: 100, bottom: 160 });

        await flushMicrotasks();

        // Re-anchor to msg-c at its live offset (60); no delta yet.
        expect(container.scrollTop).toBe(200);

        // Subsequent above growth should correct against the new anchor.
        const scrollBefore = container.scrollTop;
        setRect(msgA, { top: -10, height: 40, bottom: 30 });
        setRect(msgC, { top: 90, height: 100, bottom: 190 });
        aboveSpacer.style.height = '180px';

        await flushMicrotasks();

        expect(container.scrollTop).toBe(scrollBefore + 30);

        keeper.dispose();
    });

    test('dispose is idempotent', () => {
        const keeper = createHistoryViewportAnchorKeeper({
            container,
            anchor: { messageId: 'msg-b', offsetTop: 80 },
        });

        expect(() => {
            keeper.dispose();
            keeper.dispose();
            keeper.rebase();
        }).not.toThrow();
    });
});
