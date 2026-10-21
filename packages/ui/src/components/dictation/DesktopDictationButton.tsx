import { useEffect, useRef, type RefObject } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VoiceActivityIcon } from './VoiceActivityIcon';
import { useDictation } from '@/hooks/useDictation';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

export function DesktopDictationButton({ onInsert, onPartial, onStart, onCancel, className, iconClassName, inputRef, onCommandChange, onRecordingChange, onActiveChange, interactionMode = 'desktop', disabled = false }: {
    interactionMode?: 'desktop' | 'mobile';
    disabled?: boolean;
    onActiveChange?: (active: boolean) => void;
    inputRef?: RefObject<HTMLTextAreaElement | null>;
    onCommandChange?: (pressed: boolean) => void;
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
    const recording = dictation.status === 'recording';
    const processing = dictation.status === 'uploading';
    const mobile = interactionMode === 'mobile';
    const active = recording || processing || dictation.isStarting;
    const publishActive = useEvent((value: boolean) => onActiveChange?.(value));
    useEffect(() => {
        publishActive(active);
        return () => publishActive(false);
    }, [active, publishActive]);
    const heldPointer = useRef<number | null>(null);
    const commandPressed = useRef(false);
    const publishRecording = useEvent((active: boolean) => onRecordingChange?.(active));
    useEffect(() => {
        publishRecording(recording);
        return () => publishRecording(false);
    }, [recording, publishRecording]);
    const setCommand = useEvent((pressed: boolean) => {
        if (commandPressed.current === pressed) return;
        commandPressed.current = pressed;
        onCommandChange?.(pressed);
    });
    useEffect(() => () => setCommand(false), [setCommand]);
    const finish = useEvent(() => {
        heldPointer.current = null;
        if (recording) {
            ready.current = false;
            void dictation.confirmDictation();
        }
    });
    const toggle = useEvent(async () => {
        if (recording) { finish(); return; }
        if (processing || disabled) return;
        if (dictation.status === 'failed') {
            onCancel();
            dictation.discardFailedDictation();
        }
        ready.current = false;
        onStart();
        await dictation.startDictation();
        ready.current = true;
    });
    useEventListener('pointerdown', (event: PointerEvent) => {
        if (mobile) return;
        const input = inputRef?.current;
        if (!input || event.target !== input || input.disabled || input.readOnly
            || event.pointerType !== 'mouse' || event.button !== 0 || !event.metaKey
            || recording || processing || heldPointer.current !== null) return;
        event.preventDefault();
        heldPointer.current = event.pointerId;
        void toggle();
    }, window, { capture: true });
    useEventListener('pointerup', (event: PointerEvent) => {
        if (heldPointer.current !== event.pointerId || event.button !== 0) return;
        heldPointer.current = null;
        ready.current = false;
        void dictation.confirmDictation();
    }, window, { capture: true });
    useEventListener('pointercancel', (event: PointerEvent) => {
        if (heldPointer.current !== event.pointerId) return;
        heldPointer.current = null;
        ready.current = false;
        onCancel();
        void dictation.cancelDictation();
    }, window, { capture: true });
    useEventListener('keyup', (event: KeyboardEvent) => { if (!mobile) setCommand(event.metaKey); }, window);
    const finishHeldPointer = useEvent(() => {
        if (heldPointer.current === null) return;
        heldPointer.current = null;
        ready.current = false;
        void dictation.confirmDictation();
    });
    useEventListener('blur', () => {
        if (mobile) return;
        setCommand(false);
        if (heldPointer.current !== null) finishHeldPointer();
        else if (ready.current) finish();
    }, window);
    useEventListener('visibilitychange', () => {
        if (mobile) return;
        if (!document.hidden) return;
        setCommand(false);
        if (heldPointer.current !== null) finishHeldPointer();
        else if (ready.current) finish();
    }, document);
    useEventListener(mobile ? 'openchamber:mobile-dictation-toggle' : 'openchamber:dictation-toggle', () => { void toggle(); }, window);
    useEventListener('keydown', (event: KeyboardEvent) => {
        if (mobile) return;
        setCommand(event.metaKey);
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

    return <div className="relative flex shrink-0 items-center gap-1.5">
        <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
        <Button variant="ghost" size="icon"
            className={cn('shadow-none', className)}
            aria-label={label} aria-pressed={recording} aria-busy={processing}
            disabled={processing || (disabled && !recording)} onClick={() => { void toggle(); }} onBlur={mobile ? undefined : finish}>
            <VoiceActivityIcon kind="mic" active={recording && !dictation.error}
                className={cn(iconClassName ?? 'size-5', dictation.error && 'text-[var(--status-error)]')} />
        </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="oc-composer-tooltip max-w-64 break-words">
            {dictation.error || <span className="inline-flex items-center gap-2">
                <span>{label}</span>
                {!mobile && shortcut && <kbd className="font-sans text-[10px] opacity-70">{shortcut}</kbd>}
            </span>}
        </TooltipContent>
        </Tooltip>
        {!mobile && recording && <span className="pointer-events-none select-none whitespace-nowrap text-[10px] leading-none text-muted-foreground">
            {t(heldPointer.current !== null ? 'chat.dictation.releaseConfirm' : 'chat.dictation.keyboardHint')}
        </span>}
    </div>;
}
