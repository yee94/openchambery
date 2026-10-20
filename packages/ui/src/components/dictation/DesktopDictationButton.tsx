import { useRef } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VoiceActivityIcon } from './VoiceActivityIcon';
import { useDictation } from '@/hooks/useDictation';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

export function DesktopDictationButton({ onInsert, onPartial, onStart, onCancel, className, iconClassName }: {
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
    const finish = useEvent(() => {
        if (recording) {
            ready.current = false;
            void dictation.confirmDictation();
        }
    });
    const toggle = useEvent(async () => {
        if (recording) { finish(); return; }
        if (processing) return;
        if (dictation.status === 'failed') {
            onCancel();
            dictation.discardFailedDictation();
        }
        ready.current = false;
        onStart();
        await dictation.startDictation();
        ready.current = true;
    });
    useEventListener('blur', () => { if (ready.current) finish(); }, window);
    useEventListener('visibilitychange', () => {
        if (document.hidden && ready.current) finish();
    }, document);
    useEventListener('openchamber:dictation-toggle', () => { void toggle(); }, window);
    useEventListener('keydown', (event: KeyboardEvent) => {
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
            disabled={processing} onClick={() => { void toggle(); }} onBlur={finish}>
            <VoiceActivityIcon kind="mic" active={recording && !dictation.error}
                className={cn(iconClassName ?? 'size-5', dictation.error && 'text-[var(--status-error)]')} />
        </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="oc-composer-tooltip max-w-64 break-words">
            {dictation.error || <span className="inline-flex items-center gap-2">
                <span>{label}</span>
                {shortcut && <kbd className="font-sans text-[10px] opacity-70">{shortcut}</kbd>}
            </span>}
        </TooltipContent>
        </Tooltip>
        {recording && <span className="pointer-events-none select-none whitespace-nowrap text-[10px] leading-none text-muted-foreground">
            {t('chat.dictation.keyboardHint')}
        </span>}
    </div>;
}
