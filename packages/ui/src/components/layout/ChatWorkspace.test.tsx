import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatWorkspace } from './ChatWorkspace';

const fixture = vi.hoisted(() => ({
    width: 1000,
    reservedWidth: 600,
    publishWidth: null as ((width: number) => void) | null,
    resize: null as ResizeObserverCallback | null,
    renders: 0,
}));

vi.mock('./ContextPanel', () => ({
    ContextPanel: ({ onReservedWidthChange, fillAvailableSpace }: {
        onReservedWidthChange?: (width: number) => void;
        fillAvailableSpace?: boolean;
    }) => {
        fixture.renders++;
        fixture.publishWidth = onReservedWidthChange ?? null;
        React.useLayoutEffect(() => onReservedWidthChange?.(fixture.reservedWidth), [onReservedWidthChange]);
        return <aside data-fill={String(Boolean(fillAvailableSpace))} />;
    },
}));

let root: Root;
let host: HTMLDivElement;
const main = () => host.querySelector<HTMLElement>('[data-primary-chat]')!;
const reserve = async (width: number) => {
    fixture.reservedWidth = width;
    await act(async () => fixture.publishWidth?.(width));
};
const resize = async (width: number) => {
    fixture.width = width;
    await act(async () => fixture.resize?.([
        { contentRect: { width } } as ResizeObserverEntry,
    ], {} as ResizeObserver));
};

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(fixture, { width: 1000, reservedWidth: 600, publishWidth: null, resize: null, renders: 0 });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => fixture.width);
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { fixture.resize = callback; }
        observe() {}
        disconnect() {}
        unobserve() {}
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('hides the primary pane below 350px and restores it at exactly 350px without remounting its draft', async () => {
    await act(async () => root.render(<ChatWorkspace><textarea defaultValue="draft" /></ChatWorkspace>));
    const input = host.querySelector('textarea')!;
    input.value = 'unsent draft';
    expect(main().style.display).not.toBe('none');
    await resize(949);
    expect(main().style.display).toBe('none');
    expect(main().inert).toBe(true);
    expect(host.querySelector('aside')?.dataset.fill).toBe('true');
    await resize(950);
    expect(main().style.display).not.toBe('none');
    expect(main().inert).toBe(false);
    expect(host.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('unsent draft');
});

it('responds to live panel resizing, expansion and closing without persisting auto-collapse', async () => {
    await act(async () => root.render(<ChatWorkspace>Chat</ChatWorkspace>));
    await reserve(651);
    expect(main().style.display).toBe('none');
    await reserve(650);
    expect(main().style.display).not.toBe('none');
    await reserve(Infinity);
    expect(main().style.display).toBe('none');
    await reserve(0);
    await resize(320);
    expect(main().style.display).not.toBe('none');
});

it('does not rerender for 50 resize events that stay on the same side of the threshold', async () => {
    await act(async () => root.render(<ChatWorkspace>Chat</ChatWorkspace>));
    const before = fixture.renders;
    for (let index = 0; index < 50; index++) await reserve(600 + index % 20);
    expect(fixture.renders).toBe(before);
    await reserve(700);
    await resize(1000);
    expect(main().style.display).toBe('none');
    expect(host.querySelector('aside')?.dataset.fill).toBe('true');
    await reserve(600);
    expect(main().style.display).not.toBe('none');
});
