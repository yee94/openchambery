import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { messageHoverHandlers } from './messageHover';

test('pointer boundaries are DOM-local, preserve nested ownership, and ignore touch', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let renders = 0;
    function Fixture() {
        renders++;
        return <div data-outer {...messageHoverHandlers}><div data-inner {...messageHoverHandlers} /></div>;
    }
    try {
        await act(async () => { root.render(<Fixture />); });
        const outer = host.querySelector<HTMLElement>('[data-outer]')!;
        const inner = host.querySelector<HTMLElement>('[data-inner]')!;
        const initialRenders = renders;
        for (let i = 0; i < 50; i++) {
            inner.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
            expect(outer.hasAttribute('data-message-hovered')).toBe(true);
            expect(inner.hasAttribute('data-message-hovered')).toBe(true);
            inner.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: outer }));
            expect(inner.hasAttribute('data-message-hovered')).toBe(false);
            expect(outer.hasAttribute('data-message-hovered')).toBe(true);
            outer.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
            expect(outer.hasAttribute('data-message-hovered')).toBe(false);
        }
        inner.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch', relatedTarget: document.body }));
        expect(inner.hasAttribute('data-message-hovered')).toBe(false);
        expect(outer.hasAttribute('data-message-hovered')).toBe(false);
        expect(renders).toBe(initialRenders);
    } finally {
        await act(async () => { root.unmount(); });
        host.remove();
    }
});
