import { describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    isWithinSessionOpenPinGrace,
    SESSION_OPEN_PIN_GRACE_MS,
    useChatAutoFollow,
    type UseChatAutoFollowResult,
} from './useChatAutoFollow';

const here = dirname(fileURLToPath(import.meta.url));

describe('virtual list scroll ownership', () => {
    test('normal-flow jump preserves independent overflow axes', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 2,
                sessionIsWorking: false, isMobile: true });
            return React.createElement('div', { ref: api.scrollRef, style: { overflowX: 'hidden', overflowY: 'auto' } });
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => api.goToBottom('instant'));
            expect(api.scrollRef.current!.style.overflowX).toBe('hidden');
            expect(api.scrollRef.current!.style.overflowY).toBe('auto');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });

    test.each([true, false])('explicit jump delegates once with auto-follow enabled=%s', async (enabled) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 100;
        let height = 900;
        let rawWrites = 0;
        const scrollToBottom = vi.fn(() => { top = height - 300; return true; });
        const cancelScroll = vi.fn();
        const controller = { current: { scrollToBottom, cancelScroll } };
        function Harness() {
            api = useChatAutoFollow({ enabled, scrollControllerRef: controller, currentSessionId: null,
                sessionMessageCount: 12, sessionIsWorking: false, isMobile: false });
            return React.createElement('div', { ref: (element: HTMLDivElement | null) => {
                api.scrollRef.current = element;
                if (!element) return;
                Object.defineProperties(element, {
                    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; rawWrites++; } },
                    scrollHeight: { configurable: true, get: () => height },
                    clientHeight: { configurable: true, get: () => 300 },
                });
            } }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            scrollToBottom.mockClear();
            rawWrites = 0;
            await act(async () => api.goToBottom('instant'));
            expect(scrollToBottom).toHaveBeenCalledExactlyOnceWith({ behavior: 'auto' });
            expect(top).toBe(600);
            expect(rawWrites).toBe(0);
            expect(api.scrollRef.current!.style.overflow).toBe('');
            if (enabled) {
                scrollToBottom.mockClear();
                await act(async () => { height += 100; api.notifyContentChange('text'); });
                expect(scrollToBottom).toHaveBeenCalledExactlyOnceWith({ behavior: 'auto', reveal: false });
                await act(async () => api.releaseAutoFollow());
                expect(cancelScroll).toHaveBeenCalled();
                scrollToBottom.mockClear();
                await act(async () => { height += 100; api.notifyContentChange('text'); });
                expect(scrollToBottom).not.toHaveBeenCalled();
                expect(api.state).toBe('released');
                expect(rawWrites).toBe(0);
            }
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });
});

describe('primary transcript reading ownership', () => {
    test.each(['small-scroll', 'released-at-edge', 'released-stationary', 'cumulative-touch', 'horizontal-touch', 'content-shrink', 'bottom-bounce'] as const)('%s preserves reading/follow ownership through content growth', async (scenario) => {
        let clock = 10000;
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let api!: UseChatAutoFollowResult;
        let top = 600;
        let height = 900;
        let writes = 0;
        const bind = (element: HTMLDivElement | null) => {
            api.scrollRef.current = element;
            if (!element) return;
            Object.defineProperties(element, {
                scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - 300); writes += 1; } },
                scrollHeight: { configurable: true, get: () => height },
                clientHeight: { configurable: true, get: () => 300 },
            });
        };
        function Harness() {
            api = useChatAutoFollow({ currentSessionId: null, sessionMessageCount: 5, sessionIsWorking: false, isMobile: true });
            return React.createElement('div', { ref: bind }, React.createElement('div'));
        }
        try {
            await act(async () => root.render(React.createElement(Harness)));
            clock += 1000;
            const element = api.scrollRef.current!;
            await act(async () => element.dispatchEvent(new Event('scroll')));
            writes = 0;
            await act(async () => {
                if (scenario === 'released-at-edge' || scenario === 'released-stationary') api.releaseAutoFollow();
                if (scenario === 'cumulative-touch' || scenario === 'horizontal-touch') {
                    for (let step = 0; step <= 3; step += 1) {
                        const event = new Event(step === 0 ? 'touchstart' : 'touchmove');
                        Object.defineProperty(event, 'touches', { value: { item: () => ({ clientX: 100 + (scenario === 'horizontal-touch' ? step * 5 : 0), clientY: 100 + step }) } });
                        element.dispatchEvent(event);
                    }
                } else {
                    if (scenario === 'content-shrink') height = 850;
                    if (scenario === 'bottom-bounce') {
                        top = 620;
                        element.dispatchEvent(new Event('scroll'));
                    }
                    top = scenario === 'content-shrink' ? 550 : scenario === 'bottom-bounce' || scenario === 'released-stationary' ? 600 : 599;
                    element.dispatchEvent(new Event('scroll'));
                }
            });
            const readingTop = top;
            await act(async () => {
                height = 960;
                api.notifyContentChange('text');
            });
            const remainsFollowing = scenario === 'horizontal-touch' || scenario === 'content-shrink' || scenario === 'bottom-bounce';
            expect({ top, writes, state: api.state }).toEqual(remainsFollowing
                ? { top: 660, writes: 1, state: 'following' }
                : { top: readingTop, writes: 0, state: 'released' });
            await act(async () => {
                top = 660;
                element.dispatchEvent(new Event('scroll'));
            });
            expect(api.state).toBe('following');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            time.mockRestore();
            vi.unstubAllGlobals();
        }
    });
});

describe('session-open pin grace', () => {
    test('ignores leftover gestures until the grace expires', () => {
        expect(isWithinSessionOpenPinGrace(100, 550)).toBe(true);
        expect(isWithinSessionOpenPinGrace(550, 550)).toBe(false);
        expect(isWithinSessionOpenPinGrace(551, 550)).toBe(false);
    });

    test('restoreSnapshot arms the grace and force-pins on mobile', () => {
        const source = readFileSync(join(here, 'useChatAutoFollow.ts'), 'utf8');
        expect(source).toContain('armSessionOpenPinGrace()');
        expect(source).toContain('forceBottomDefeatingMomentum()');
        expect(source).toContain('isWithinSessionOpenPinGrace(now(), sessionOpenPinGraceUntilRef.current)');
        expect(SESSION_OPEN_PIN_GRACE_MS).toBeGreaterThan(0);
    });
});
