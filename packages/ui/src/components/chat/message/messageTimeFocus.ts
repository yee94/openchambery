import React from 'react';

/**
 * Mobile stand-in for desktop hover on absolute message times.
 * A tap focuses one message; a tap outside clears it. DOM focus is not moved,
 * so the composer keyboard stays up.
 */

const TAP_SLOP_PX = 12;
const TAP_SLOP_SQ = TAP_SLOP_PX * TAP_SLOP_PX;

type Listener = () => void;

let focusedMessageId: string | null = null;
const listeners = new Set<Listener>();
let outsideListenerInstalled = false;

const SERVER_FOCUS: string | null = null;

function emit(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function getFocusedMessageTimeId(): string | null {
    return focusedMessageId;
}

function getServerFocusedMessageTimeId(): string | null {
    return SERVER_FOCUS;
}

function subscribeMessageTimeFocus(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useMessageTimeFocused(messageId: string, enabled: boolean): boolean {
    const focusedId = React.useSyncExternalStore(
        subscribeMessageTimeFocus,
        getFocusedMessageTimeId,
        getServerFocusedMessageTimeId,
    );
    return enabled && focusedId === messageId;
}

export function focusMessageTime(messageId: string): void {
    if (!messageId || focusedMessageId === messageId) return;
    focusedMessageId = messageId;
    emit();
}

export function clearMessageTimeFocus(messageId?: string): void {
    if (focusedMessageId === null) return;
    if (messageId && focusedMessageId !== messageId) return;
    focusedMessageId = null;
    emit();
}

function messageIdFromTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
}

function installOutsideClear(): void {
    if (outsideListenerInstalled || typeof document === 'undefined') return;
    outsideListenerInstalled = true;
    document.addEventListener('pointerdown', (event) => {
        if (!focusedMessageId) return;
        if (messageIdFromTarget(event.target) === focusedMessageId) return;
        clearMessageTimeFocus();
    }, true);
}

/** Tap (not scroll) on a message row reveals its absolute time. */
export function bindMessageTimeFocus(root: HTMLElement, messageId: string): () => void {
    installOutsideClear();
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        tracking = true;
        startX = event.clientX;
        startY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
        if (!tracking) return;
        tracking = false;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (dx * dx + dy * dy > TAP_SLOP_SQ) return;
        focusMessageTime(messageId);
    };
    const onPointerCancel = () => {
        tracking = false;
    };

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerCancel);
    return () => {
        root.removeEventListener('pointerdown', onPointerDown);
        root.removeEventListener('pointerup', onPointerUp);
        root.removeEventListener('pointercancel', onPointerCancel);
        clearMessageTimeFocus(messageId);
    };
}

export function resetMessageTimeFocusForTests(): void {
    focusedMessageId = null;
    listeners.clear();
}
