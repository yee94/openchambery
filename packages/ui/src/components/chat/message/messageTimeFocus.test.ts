import { describe, expect, test } from 'vitest';
import {
    bindMessageTimeFocus,
    clearMessageTimeFocus,
    focusMessageTime,
    getFocusedMessageTimeId,
    resetMessageTimeFocusForTests,
} from './messageTimeFocus';

describe('messageTimeFocus', () => {
    test('tap focuses one message and an outside tap clears it', () => {
        resetMessageTimeFocusForTests();
        const row = document.createElement('div');
        row.setAttribute('data-message-id', 'msg-a');
        document.body.append(row);
        const unbind = bindMessageTimeFocus(row, 'msg-a');

        row.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
        row.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 12, clientY: 11, bubbles: true }));
        expect(getFocusedMessageTimeId()).toBe('msg-a');

        document.body.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
        expect(getFocusedMessageTimeId()).toBeNull();

        unbind();
        row.remove();
    });

    test('a drag does not focus, and focusing another message replaces the previous one', () => {
        resetMessageTimeFocusForTests();
        const row = document.createElement('div');
        row.setAttribute('data-message-id', 'msg-a');
        document.body.append(row);
        const unbind = bindMessageTimeFocus(row, 'msg-a');

        row.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
        row.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 40, clientY: 0, bubbles: true }));
        expect(getFocusedMessageTimeId()).toBeNull();

        focusMessageTime('msg-b');
        row.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 4, clientY: 4, bubbles: true }));
        expect(getFocusedMessageTimeId()).toBeNull();
        row.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 5, clientY: 4, bubbles: true }));
        expect(getFocusedMessageTimeId()).toBe('msg-a');

        clearMessageTimeFocus('other');
        expect(getFocusedMessageTimeId()).toBe('msg-a');
        unbind();
        expect(getFocusedMessageTimeId()).toBeNull();
        row.remove();
    });
});
