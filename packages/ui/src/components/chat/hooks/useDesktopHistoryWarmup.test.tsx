import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesktopHistoryWarmup } from './useDesktopHistoryWarmup';

describe('desktop history warmup', () => {
    let root: Root;
    let host: HTMLDivElement;
    let scroller: HTMLDivElement;
    let options: Parameters<typeof useDesktopHistoryWarmup>[0];
    const load = vi.fn<() => Promise<void>>();
    function Probe() { useDesktopHistoryWarmup(options); return null; }
    const render = async () => { await act(async () => root.render(<Probe />)); };
    const advance = async (ms = 1200) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };

    beforeEach(async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.useFakeTimers();
        load.mockReset().mockResolvedValue(undefined);
        host = document.createElement('div');
        scroller = document.createElement('div');
        document.body.append(host, scroller);
        root = createRoot(host);
        options = { scope: 'runtime/directory/session', enabled: true, cursor: 'first', loadedTurns: 3,
            messages: [], scrollRef: { current: scroller }, loadPrevious: load };
        await render();
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        scroller.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('waits for quiet rendering and requests one large message page', async () => {
        await advance(600);
        expect(load).not.toHaveBeenCalled();
        options = { ...options, messages: [{}] };
        await render();
        await advance(600);
        expect(load).not.toHaveBeenCalled();
        await advance();
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenLastCalledWith(50);
        await advance(5000);
        expect(load).toHaveBeenCalledTimes(1);
        for (const loadedTurns of [7, 11]) {
            options = { ...options, cursor: String(loadedTurns), loadedTurns };
            await render();
            await advance();
        }
        expect(load).toHaveBeenCalledTimes(1);
        options = { ...options, cursor: 'enough', loadedTurns: 15 };
        await render();
        await advance(5000);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('does no work while disabled or history is exhausted', async () => {
        options = { ...options, enabled: false };
        await render();
        await advance(5000);
        expect(load).not.toHaveBeenCalled();
        options = { ...options, enabled: true, cursor: null };
        await render();
        await advance(5000);
        expect(load).not.toHaveBeenCalled();
    });

    it('waits for scroll and layout changes to settle', async () => {
        await advance(600);
        scroller.scrollTop = 50;
        await advance(600);
        expect(load).not.toHaveBeenCalled();
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });
        await advance(600);
        expect(load).not.toHaveBeenCalled();
        await advance();
        expect(load).toHaveBeenCalledTimes(1);
        expect(scroller.scrollTop).toBe(50);
    });

    it('stops on failure and permits a new session to warm', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        load.mockRejectedValueOnce(new Error('offline'));
        await advance();
        options = { ...options, cursor: 'changed-by-manual-load' };
        await render();
        await advance(5000);
        expect(load).toHaveBeenCalledTimes(1);
        options = { ...options, scope: 'other-session' };
        await render();
        await advance();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not overlap flights or fetch a stale session after navigation', async () => {
        let finish!: () => void;
        load.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        await advance();
        options = { ...options, scope: 'new-session', cursor: 'new-cursor' };
        await render();
        await advance(3000);
        expect(load).toHaveBeenCalledTimes(1);
        await act(async () => finish());
        await advance();
        expect(load).toHaveBeenCalledTimes(2);
    });
});
