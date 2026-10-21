import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useEvent } from '@reactuses/core';
import { resolveComposerTextareaAutosize } from './composerTextareaAutosize';

export function useComposerTextareaAutosize({ inputRef, message, expanded, isMobile, dictationHeight, manualHeight = false }: {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    message: string;
    expanded: boolean;
    isMobile: boolean;
    dictationHeight: number | null;
    manualHeight?: boolean;
}) {
    const [size, setSize] = useState<{ height: number; maxHeight: number } | null>(null);
    const previousLayout = useRef<{ length: number; expanded: boolean; dictationHeight: number | null; manualHeight: boolean } | null>(null);
    const resize = useEvent((options?: { allowShrink?: boolean }) => {
        const textarea = inputRef.current;
        if (!textarea) return;
        if (manualHeight) return;
        const previousScrollTop = textarea.scrollTop;

        if (expanded) {
            textarea.style.height = '100%';
            textarea.style.maxHeight = 'none';
            textarea.style.overflowY = 'auto';
            setSize(null);
            if (textarea.scrollTop !== previousScrollTop) textarea.scrollTop = previousScrollTop;
            return;
        }

        // Measure with overflow clipped so scrollHeight is content height,
        // not a leftover scrollport from a previous cap.
        textarea.style.overflow = 'hidden';
        textarea.style.overflowX = 'hidden';
        textarea.style.overflowY = 'hidden';
        if (options?.allowShrink ?? true) textarea.style.height = 'auto';

        const view = textarea.ownerDocument?.defaultView;
        const computedStyle = view ? view.getComputedStyle(textarea) : null;
        const lineHeight = computedStyle ? parseFloat(computedStyle.lineHeight) : NaN;
        const paddingTop = computedStyle ? parseFloat(computedStyle.paddingTop) : NaN;
        const paddingBottom = computedStyle ? parseFloat(computedStyle.paddingBottom) : NaN;
        const paddingTotal = Number.isNaN(paddingTop) || Number.isNaN(paddingBottom) ? 16 : paddingTop + paddingBottom;
        const sized = resolveComposerTextareaAutosize({
            scrollHeight: textarea.scrollHeight || textarea.offsetHeight,
            dictationHeight: dictationHeight ?? 0,
            lineHeight: Number.isNaN(lineHeight) ? 22 : lineHeight,
            paddingTotal,
        });

        textarea.style.height = `${sized.height}px`;
        textarea.style.maxHeight = `${sized.maxHeight}px`;
        textarea.style.overflowY = sized.overflowY;
        if (textarea.scrollTop !== previousScrollTop) textarea.scrollTop = previousScrollTop;
        setSize((prev) => prev?.height === sized.height && prev.maxHeight === sized.maxHeight
            ? prev : { height: sized.height, maxHeight: sized.maxHeight });
    });

    useLayoutEffect(() => {
        const previous = previousLayout.current;
        // Growing transcript never shrinks mid-recording (matches typing);
        // dictation ending (null) releases the height back to the message.
        const allowShrink = !previous || previous.manualHeight || message.length < previous.length || expanded !== previous.expanded
            || (previous.dictationHeight !== null && dictationHeight === null);
        previousLayout.current = { length: message.length, expanded, dictationHeight, manualHeight };
        resize({ allowShrink });
    }, [message, expanded, isMobile, dictationHeight, manualHeight, inputRef, resize]);

    return { size, resize };
}
