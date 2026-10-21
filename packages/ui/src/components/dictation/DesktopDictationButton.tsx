import { useEffect, useRef, useState, type RefObject } from 'react';
import { useEvent, useEventListener, useTimeoutFn } from '@reactuses/core';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VoiceActivityIcon } from './VoiceActivityIcon';
import { useDictation } from '@/hooks/useDictation';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { DictationLoading } from './DictationLoading';

export function DesktopDictationButton({ onInsert, onPartial, onStart, onCancel, className, iconClassName, inputRef, onRecordingChange, onActiveChange, interactionMode = 'desktop', disabled = false }: {
    interactionMode?: 'desktop' | 'mobile';
    disabled?: boolean;
    onActiveChange?: (active: boolean) => void;
    inputRef?: RefObject<HTMLTextAreaElement | null>;
    onRecordingChange?: (recording: boolean) => void;
    className?: string;
    iconClassName?: string;
    onInsert: (text: string) => void;
    onPartial: (text: string) => void;
    onStart: () => void;
    onCancel: () => void;
}) {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const shortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides));
    const dictation = useDictation({
        onTranscript: onInsert,
        onPartialTranscript: onPartial,
    });
    const ready = useRef(false);
    const [preparing, setPreparing] = useState(false);
    const [finalizing, setFinalizing] = useState(false);
    const starting = preparing || dictation.isStarting;
    const recording = dictation.status === 'recording';
    const processing = dictation.status === 'uploading';
    const mobile = interactionMode === 'mobile';
    const loading = starting || finalizing || processing;
    const active = recording || loading;
    const publishActive = useEvent((value: boolean) => onActiveChange?.(value));
    useEffect(() => {
        publishActive(active);
        return () => publishActive(false);
    }, [active, publishActive]);
    const heldPointer = useRef<number | null>(null);
    const pendingPointer = useRef<{ id: number; x: number; y: number } | null>(null);
    const pointerCaptureTarget = useRef<HTMLDivElement>(null);
    const listeningCursor = useRef<HTMLSpanElement>(null);
    const pointerPosition = useRef({ x: 0, y: 0 });
    const publishRecording = useEvent((active: boolean) => onRecordingChange?.(active));
    useEffect(() => {
        publishRecording(recording && (mobile || !loading));
        return () => publishRecording(false);
    }, [recording, loading, mobile, publishRecording]);
    const focusGeneration = useRef(0);
    useEffect(() => () => { focusGeneration.current += 1; }, []);
    const confirm = useEvent(async (restoreFocus = false) => {
        if (finalizing) return;
        const input = inputRef?.current;
        const generation = focusGeneration.current;
        ready.current = false;
        setFinalizing(true);
        try {
            await dictation.confirmDictation();
        } finally {
            setFinalizing(false);
            if (restoreFocus && !mobile && generation === focusGeneration.current
                && input?.isConnected && inputRef?.current === input && !input.disabled && !input.readOnly
                && !document.hidden && document.hasFocus()
                && (document.activeElement === document.body || document.activeElement === input
                    || pointerCaptureTarget.current?.contains(document.activeElement))) {
                input.focus({ preventScroll: true });
                input.setSelectionRange(input.value.length, input.value.length);
            }
        }
    });
    const finish = useEvent(() => {
        heldPointer.current = null;
        if (recording) {
            ready.current = false;
            void confirm();
        }
    });
    const toggle = useEvent(async () => {
        if (finalizing || processing) return;
        if (recording) { finish(); return; }
        if (processing || starting || disabled) return;
        if (dictation.status === 'failed') {
            onCancel();
            dictation.discardFailedDictation();
        }
        ready.current = false;
        onStart();
        setPreparing(true);
        try {
            await dictation.startDictation();
            ready.current = true;
        } finally {
            setPreparing(false);
        }
    });
    const [, startHold, stopHold] = useTimeoutFn(() => {
        const pointer = pendingPointer.current;
        pendingPointer.current = null;
        const input = inputRef?.current;
        if (!pointer || !input || input.disabled || input.readOnly || disabled || active
            || input.selectionStart !== input.selectionEnd) return;
        heldPointer.current = pointer.id;
        pointerCaptureTarget.current?.setPointerCapture?.(pointer.id);
        input.blur();
        input.setSelectionRange(input.value.length, input.value.length);
        void toggle();
    }, 500, { immediate: false });
    const cancelPendingHold = useEvent(() => {
        if (!pendingPointer.current) return;
        pendingPointer.current = null;
        stopHold();
    });
    useEventListener('pointerdown', (event: PointerEvent) => {
        if (mobile) return;
        const input = inputRef?.current;
        if (!input || event.target !== input || input.disabled || input.readOnly
            || event.pointerType !== 'mouse' || event.button !== 0 || event.detail > 1
            || disabled || active || heldPointer.current !== null) return;
        pendingPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        startHold();
    }, window, { capture: true });
    useEventListener('pointermove', (event: PointerEvent) => {
        const pending = pendingPointer.current;
        if (pending?.id === event.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 6) cancelPendingHold();
        if (heldPointer.current !== event.pointerId) return;
        event.preventDefault();
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        if (listeningCursor.current) {
            listeningCursor.current.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
        }
    }, window, { capture: true });
    useEventListener('selectstart', (event: Event) => {
        if (heldPointer.current !== null) event.preventDefault();
    }, document, { capture: true });
    useEventListener('mousemove', (event: MouseEvent) => {
        if (heldPointer.current !== null) event.preventDefault();
    }, window, { capture: true });
    useEventListener('selectionchange', () => {
        if (heldPointer.current === null) return;
        const input = inputRef?.current;
        if (input && input.selectionStart !== input.selectionEnd) {
            input.setSelectionRange(input.selectionEnd, input.selectionEnd);
        }
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
    }, document);
    useEventListener('pointerup', (event: PointerEvent) => {
        if (pendingPointer.current?.id === event.pointerId) cancelPendingHold();
        if (heldPointer.current !== event.pointerId || event.button !== 0) return;
        heldPointer.current = null;
        ready.current = false;
        void confirm(true);
    }, window, { capture: true });
    useEventListener('pointercancel', (event: PointerEvent) => {
        if (pendingPointer.current?.id === event.pointerId) cancelPendingHold();
        if (heldPointer.current !== event.pointerId) return;
        heldPointer.current = null;
        ready.current = false;
        onCancel();
        void dictation.cancelDictation();
    }, window, { capture: true });
    const finishHeldPointer = useEvent(() => {
        if (heldPointer.current === null) return;
        heldPointer.current = null;
        ready.current = false;
        void confirm();
    });
    useEventListener('blur', () => {
        if (mobile) return;
        cancelPendingHold();
        if (heldPointer.current !== null) finishHeldPointer();
        else if (ready.current) finish();
    }, window);
    useEventListener('visibilitychange', () => {
        if (mobile) return;
        if (!document.hidden) return;
        cancelPendingHold();
        if (heldPointer.current !== null) finishHeldPointer();
        else if (ready.current) finish();
    }, document);
    useEventListener(mobile ? 'openchamber:mobile-dictation-toggle' : 'openchamber:dictation-toggle', () => { void toggle(); }, window);
    useEventListener('keydown', (event: KeyboardEvent) => {
        if (mobile) return;
        cancelPendingHold();
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && (recording || processing)) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) finish();
            return;
        }
        if (event.key !== 'Escape' || (!recording && !processing && dictation.status !== 'failed')) return;
        event.preventDefault();
        event.stopPropagation();
        ready.current = false;
        heldPointer.current = null;
        onCancel();
        if (dictation.status === 'failed') dictation.discardFailedDictation();
        else void dictation.cancelDictation();
    }, window, { capture: true });

    const label = t(recording ? 'settings.voice.volcengine.finishRecording'
        : processing ? 'chat.dictation.processing'
            : 'chat.dictation.start');

    return <div ref={pointerCaptureTarget} data-dictation-control className="relative flex shrink-0 items-center gap-1.5">
        {!mobile && (recording || starting) && heldPointer.current !== null && createPortal(
            <span ref={listeningCursor} data-listening-cursor aria-hidden="true"
                className="pointer-events-none fixed left-0 top-0 z-[100]"
                style={{ transform: `translate(${pointerPosition.current.x}px, ${pointerPosition.current.y}px)` }}>
                <style>{'html, html * { cursor: none !important; user-select: none !important; -webkit-user-select: none !important; } @keyframes oc-listening-cursor { from { transform: scaleY(0.35); } to { transform: scaleY(1); } }'}</style>
                <span className="absolute -left-5 -top-5 flex size-10 items-center justify-center gap-1">
                    {starting ? <DictationLoading decorative /> : [0, 1, 2].map((bar) => <span key={bar}
                        className="h-6 w-[3px] rounded-full bg-[var(--voice-active-fill)] motion-safe:animate-[oc-listening-cursor_450ms_ease-in-out_infinite_alternate]"
                        style={{ animationDelay: `${bar * -150}ms` }} />)}
                </span>
            </span>, document.body)}
        <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
        <Button variant="ghost" size="icon"
            className={cn('shadow-none', className)}
            aria-label={label} aria-pressed={recording} aria-busy={loading}
            disabled={processing || finalizing || (disabled && !recording)} onClick={() => { void toggle(); }} onBlur={mobile ? undefined : finish}>
            {loading ? <DictationLoading decorative />
                : <VoiceActivityIcon kind="mic" active={recording && !dictation.error}
                    className={cn(iconClassName ?? 'size-5', dictation.error && 'text-[var(--status-error)]')} />}
        </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="oc-composer-tooltip max-w-64 break-words">
            {dictation.error || <span className="inline-flex items-center gap-2">
                <span>{label}</span>
                {!mobile && shortcut && <kbd className="font-sans text-[10px] opacity-70">{shortcut}</kbd>}
            </span>}
        </TooltipContent>
        </Tooltip>
        {!mobile && recording && !loading && <span className="pointer-events-none select-none whitespace-nowrap text-[10px] leading-none text-muted-foreground">
            {t(heldPointer.current !== null ? 'chat.dictation.releaseConfirm' : 'chat.dictation.keyboardHint')}
        </span>}
    </div>;
}
