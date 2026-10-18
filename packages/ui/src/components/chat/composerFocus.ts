import type { PointerEvent, RefObject } from 'react';

export const preventComposerActionPointerFocus = (
    event: PointerEvent<HTMLElement>,
    markComposerActionGesture: () => void,
): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Portals still propagate through the React parent form. Its focus policy
    // owns only DOM descendants, never inputs in a portaled picker or dialog.
    if (!event.currentTarget.contains(target)) return;
    // Only the textarea (and its highlight overlay) may claim focus /
    // expand the composer. Footer chrome (attach, agent, model, send, …)
    // is an explicit action — preventDefault so the browser never
    // focuses the field as a side effect of the tap.
    if (target.closest('textarea[data-chat-input="true"]')) return;
    if (target.closest('[data-chat-prompt-attachments="true"]')) return;
    const action = target.closest(
        'button, [role="button"], a, label, input, select, [data-composer-action="true"], [data-chat-input-footer="true"]',
    );
    if (!action) return;
    markComposerActionGesture();
    event.preventDefault();
};

export const resolveComposerTextarea = (
    textareaRef: RefObject<HTMLTextAreaElement | null>,
): HTMLTextAreaElement | null => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.isConnected || textarea.disabled) {
        return null;
    }
    return textarea;
};

export const focusComposerTextarea = (
    textareaRef: RefObject<HTMLTextAreaElement | null>,
): boolean => {
    const textarea = resolveComposerTextarea(textareaRef);
    if (!textarea) {
        return false;
    }
    textarea.focus({ preventScroll: true });
    return true;
};

export const shouldApplyComposerDomCorrection = (
    correctionRequested: boolean,
    nativeCompositionActive: boolean,
): boolean => correctionRequested && !nativeCompositionActive;
