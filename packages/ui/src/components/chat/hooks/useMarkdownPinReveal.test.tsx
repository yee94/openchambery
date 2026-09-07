import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { useMarkdownPinReveal } from './useMarkdownPinReveal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createTimelineRoot = () => {
    const timeline = document.createElement('div');
    timeline.innerHTML = `
        <div data-turn-entry="turn:pending">
            <div data-markdown-ready="false"><div data-markdown-content></div></div>
        </div>
    `;
    document.body.appendChild(timeline);
    return timeline;
};

const Probe = ({
    timeline,
    generation = 0,
    initiallyRevealed = false,
}: {
    timeline: HTMLElement;
    generation?: number;
    initiallyRevealed?: boolean;
}) => {
    const hidden = useMarkdownPinReveal({
        scopeKey: 'session:handoff',
        generation,
        root: timeline,
        relevantKeys: ['turn:pending'],
        initiallyRevealed,
    });
    return <span data-hidden={String(hidden)} />;
};

describe('useMarkdownPinReveal handoff seed', () => {
    let host: HTMLElement;
    let root: Root;
    let timeline: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        timeline = createTimelineRoot();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        timeline.remove();
    });

    test('keeps a previously committed handoff visible while its replacement markdown settles', async () => {
        await act(async () => {
            root.render(<Probe timeline={timeline} initiallyRevealed />);
        });

        expect(host.querySelector('[data-hidden]')?.getAttribute('data-hidden')).toBe('false');
        expect(timeline.style.visibility).toBe('');
        expect(timeline.getAttribute('data-markdown-pin-reveal')).toBe('ready');
    });

    test('preserves the cold gate and re-arms an explicit jump after handoff', async () => {
        await act(async () => {
            root.render(<Probe timeline={timeline} initiallyRevealed />);
        });
        await act(async () => {
            root.render(<Probe timeline={timeline} generation={1} initiallyRevealed />);
        });

        expect(host.querySelector('[data-hidden]')?.getAttribute('data-hidden')).toBe('true');
        expect(timeline.style.visibility).toBe('hidden');

        await act(async () => {
            timeline.querySelector('[data-markdown-ready]')?.setAttribute('data-markdown-ready', 'true');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(host.querySelector('[data-hidden]')?.getAttribute('data-hidden')).toBe('false');
        expect(timeline.style.visibility).toBe('');
    });

    test('arms an ordinary cold session', async () => {
        await act(async () => {
            root.render(<Probe timeline={timeline} />);
        });

        expect(host.querySelector('[data-hidden]')?.getAttribute('data-hidden')).toBe('true');
        expect(timeline.style.visibility).toBe('hidden');
    });
});
