import React from 'react';
import { createPortal } from 'react-dom';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useMobileBackRoute } from '@/mobile/mobileBackNavigation';
import { animateMediaPreview } from './mediaPreviewTransition';
import { mobileWindowStack } from '@/components/ui/MobileWindowStack';

export function PreviewCloseButton({ onClose, isMobile, size }: {
    onClose: () => void;
    isMobile: boolean;
    size?: { width: number; height: number };
}) {
    const { t } = useI18n();
    return <div className="absolute right-3 z-20" style={isMobile ? {
        top: 'calc(var(--oc-safe-area-top, 0px) + 0.5rem)',
        right: 'calc(var(--oc-safe-area-right, 0px) + 0.75rem)',
    } : {
        top: size ? `calc(50% - ${size.height / 2}px + 0.5rem)` : '0.5rem',
        right: size ? `calc(50% - ${size.width / 2}px + 0.5rem)` : '0.5rem',
    }}>
        <Button variant="mobileGlass" size="mobileIcon" aria-label={t('dialog.common.actions.close')} onClick={onClose}>
            <Icon name="close" className="size-5" />
        </Button>
    </div>;
}

export function MediaPreviewToolbar({ children }: { children: React.ReactNode }) {
    return <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-2"
        style={{ bottom: 'calc(var(--oc-safe-area-bottom, 0px) + 0.5rem)' }}>
        <div data-media-preview-toolbar=""
            className="pointer-events-auto flex h-10 items-center gap-0.5 rounded-full border border-[color-mix(in_srgb,var(--oc-media-preview-foreground)_15%,transparent)] bg-[color-mix(in_srgb,var(--oc-media-preview-foreground)_10%,transparent)] px-1 text-[var(--oc-media-preview-foreground)] shadow-lg backdrop-blur-xl"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}>
            {children}
        </div>
    </div>;
}

export function MediaPreviewOverlay({ open, title, kind, source, isMobile, onOpenChange, children }: {
    open: boolean;
    title: string;
    kind: 'image' | 'mermaid' | 'video';
    source?: HTMLElement;
    isMobile: boolean;
    onOpenChange: (open: boolean) => void;
    children: (close: () => void) => React.ReactNode;
}) {
    const viewerRef = React.useRef<HTMLDivElement>(null);
    const modalId = React.useId();
    const cancelRef = React.useRef<(() => void) | null>(null);
    const closingRef = React.useRef(false);
    const [closed, setClosed] = React.useState(false);
    const close = useEvent(() => {
        if (closingRef.current) return;
        closingRef.current = true;
        cancelRef.current?.();
        const target = viewerRef.current?.querySelector<HTMLElement>('[data-preview-transition-target]') ?? null;
        cancelRef.current = animateMediaPreview(
            target?.dataset.previewReturn === 'false' ? undefined : source,
            target, viewerRef.current, true,
            () => { setClosed(true); onOpenChange(false); },
        );
    });

    useMobileBackRoute({ id: `${kind}-preview`, active: open && !closed && isMobile, layer: 'overlay', onBack: close, surfaceRef: viewerRef });

    React.useLayoutEffect(() => {
        if (!open) { setClosed(false); closingRef.current = false; return; }
        if (closed) return;
        const viewer = viewerRef.current;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const removeModal = isMobile ? mobileWindowStack.add({ id: modalId, onClose: close }, document.body) : undefined;
        viewer?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
        cancelRef.current = animateMediaPreview(source,
            viewer?.querySelector<HTMLElement>('[data-preview-transition-target]') ?? null, viewer, false);
        return () => {
            cancelRef.current?.();
            cancelRef.current = null;
            closingRef.current = false;
            removeModal?.();
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        };
    }, [closed, open, source, isMobile, modalId, close]);

    if (!open || closed || typeof document === 'undefined') return null;
    return createPortal(<div ref={viewerRef} role="dialog" aria-modal="true" aria-label={title}
        data-media-preview={kind} data-page-scroll-lock="true" tabIndex={-1}
        className="fixed inset-0 z-[80] overflow-hidden select-none [-webkit-touch-callout:none]"
        style={{
            backgroundColor: isMobile ? 'var(--oc-media-preview-background)' : `color-mix(in srgb, var(--oc-media-preview-background) ${kind === 'mermaid' ? 90 : 70}%, transparent)`,
            color: 'var(--oc-media-preview-foreground)',
        }}
        onClick={(event) => { event.stopPropagation(); }}
        onKeyDown={(event) => {
            if (!event.currentTarget.contains(event.target as Node)) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key !== 'Tab') return;
            const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'));
            const first = elements[0];
            const last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
    >{children(close)}</div>, document.body);
}
