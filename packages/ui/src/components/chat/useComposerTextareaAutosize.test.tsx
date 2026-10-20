import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useComposerTextareaAutosize } from './useComposerTextareaAutosize';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let contentHeight: number;
let result: ReturnType<typeof useComposerTextareaAutosize>;
const inputRef = { current: null as HTMLTextAreaElement | null };

function Probe({ message = '', expanded = false, dictationHeight = null, isMobile = false }: {
    message?: string; expanded?: boolean; dictationHeight?: number | null; isMobile?: boolean;
}) {
    result = useComposerTextareaAutosize({ inputRef, message, expanded, dictationHeight, isMobile });
    return null;
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const textarea = document.createElement('textarea');
    textarea.style.lineHeight = '20px';
    textarea.style.padding = '4px';
    contentHeight = 48;
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => contentHeight });
    host.append(textarea);
    inputRef.current = textarea;
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    inputRef.current = null;
    vi.restoreAllMocks();
});

it('measures once per semantic edit and does no layout work for unrelated renders', async () => {
    const measure = vi.spyOn(window, 'getComputedStyle');
    await act(async () => root.render(<Probe message="a" />));
    expect(measure).toHaveBeenCalledTimes(1);
    const resize = result.resize;
    const size = result.size;
    measure.mockClear();
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Probe message="a" />));
    expect(measure).not.toHaveBeenCalled();
    expect(result.resize).toBe(resize);
    expect(result.size).toBe(size);
    await act(async () => root.render(<Probe message="ab" />));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(size);
});

it('resizes on expansion and collapse with unchanged text and preserves scroll', async () => {
    await act(async () => root.render(<Probe message="same" />));
    inputRef.current!.scrollTop = 12;
    const resize = result.resize;
    await act(async () => root.render(<Probe message="same" expanded />));
    expect(inputRef.current!.style.height).toBe('100%');
    expect(result.size).toBeNull();
    expect(inputRef.current!.scrollTop).toBe(12);
    await act(async () => resize());
    expect(inputRef.current!.style.height).toBe('100%');
    const measure = vi.spyOn(window, 'getComputedStyle');
    await act(async () => root.render(<Probe message="same" />));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(inputRef.current!.style.height).toBe('48px');
    expect(inputRef.current!.scrollTop).toBe(12);
});

it('coalesces simultaneous text and dictation changes and shrinks when dictation ends', async () => {
    await act(async () => root.render(<Probe message="a" />));
    const measure = vi.spyOn(window, 'getComputedStyle');
    await act(async () => root.render(<Probe message="ab" dictationHeight={100} />));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(Number.parseFloat(inputRef.current!.style.height)).toBeGreaterThanOrEqual(100);
    measure.mockClear();
    await act(async () => root.render(<Probe message="ab" />));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(inputRef.current!.style.height).toBe('48px');
});

it('skips resetting height during text growth and allows shrinking on deletion', async () => {
    await act(async () => root.render(<Probe message="ab" />));
    const heights: string[] = [];
    Object.defineProperty(inputRef.current!, 'scrollHeight', {
        configurable: true, get: () => { heights.push(inputRef.current!.style.height); return contentHeight; },
    });
    await act(async () => root.render(<Probe message="abc" />));
    expect(heights).toEqual(['48px']);
    heights.length = 0;
    await act(async () => root.render(<Probe message="a" />));
    expect(heights).toEqual(['auto']);
});
