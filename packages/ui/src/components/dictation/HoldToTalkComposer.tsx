import { useEffect, useId, useRef, useState, type RefObject, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useDictation } from '@/hooks/useDictation';
import { getDefaultTheme } from '@/lib/theme/themes';
import './hold-to-talk.css';

const speechColors = getDefaultTheme(false).colors;
const cancelTargetPath = 'M-50 74.564 A600 600 0 0 1 147.707 22.283 A38 38 0 0 1 154.330 97.994 A524 524 0 0 0 -18.333 143.653 Z';
const editTargetPath = 'M450 74.564 A600 600 0 0 0 252.293 22.283 A38 38 0 0 0 245.670 97.994 A524 524 0 0 1 418.333 143.653 Z';
const speechPalette = {
    colorScheme: 'light',
    '--surface-background': speechColors.surface.background,
    '--surface-foreground': speechColors.surface.foreground,
    '--primary-base': speechColors.primary.base,
    '--foreground': speechColors.surface.background,
    '--interactive-hover': 'color-mix(in srgb, var(--surface-background) 12%, transparent)',
    '--interactive-active': 'color-mix(in srgb, var(--surface-background) 20%, transparent)',
    '--ring': speechColors.interactive.focusRing,
    '--status-error': speechColors.status.error,
} as CSSProperties;

interface Props {
    containerRef: RefObject<HTMLFormElement | null>;
    disabled: boolean;
    onInsert: (text: string) => void;
    onSend: (text: string) => void;
    onHintChange: (hint: 'recording' | 'cancelling' | 'editing' | 'processing' | null) => void;
}

export function HoldToTalkComposer({ containerRef, disabled, onInsert, onSend, onHintChange }: Props) {
    const { t } = useI18n();
    const [held, setHeld] = useState(false);
    const [intent, setIntent] = useState<'send' | 'cancel' | 'edit'>('send');
    const gesture = useRef<{ pointer: number; x: number; y: number; intent: 'send' | 'cancel' | 'edit'; started: boolean } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const action = useRef<'send' | 'insert'>('send');
    const gestureStage = useRef<SVGGElement>(null);
    const arcGradientId = useId();
    const cancelClipId = useId();
    const editClipId = useId();
    const dictation = useDictation({ onTranscript: (text) => action.current === 'send' ? onSend(text) : onInsert(text) });
    const { status, partialTranscript, error, volume } = dictation;
    const publishHint = useEvent(onHintChange);
    const hint = held ? intent === 'cancel' ? 'cancelling' : intent === 'edit' ? 'editing' : 'recording' : status === 'uploading' ? 'processing' : null;
    useEffect(() => { publishHint(hint); }, [hint, publishHint]);
    useEffect(() => () => publishHint(null), [publishHint]);
    const clearTimer = useEvent(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; });
    const emptyInputForTarget = useEvent((target: EventTarget | null) => {
        if (disabled || !(target instanceof HTMLElement)) return null;
        const input = containerRef.current?.querySelector('textarea');
        if (!input || input.value !== '' || input.disabled || input.readOnly) return null;
        if (target !== input && !target.closest('[data-oc-composer-compact-surface]')) return null;
        if (target.closest('button, [data-composer-action]')) return null;
        return input;
    });
    const cancel = useEvent(() => {
        clearTimer();
        gesture.current = null;
        setHeld(false);
        setIntent('send');
        if (status === 'failed' || (status === 'idle' && error)) dictation.discardFailedDictation();
        else void dictation.cancelDictation();
    });
    const down = useEvent((event: PointerEvent) => {
        const target = event.target;
        if (disabled || status !== 'idle' || gesture.current || !event.isPrimary || event.button !== 0 || !(target instanceof HTMLElement)) return;
        if (!emptyInputForTarget(target)) return;
        event.preventDefault();
        event.stopPropagation();
        gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, intent: 'send', started: false };
        timer.current = setTimeout(() => {
            timer.current = null;
            if (!gesture.current) return;
            const input = emptyInputForTarget(target);
            if (!input) { gesture.current = null; return; }
            input.blur();
            gesture.current.started = true;
            action.current = 'send';
            setHeld(true);
            setIntent('send');
            void dictation.startDictation();
        }, 300);
    });
    const move = useEvent((event: PointerEvent) => {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const dx = event.clientX - current.x;
        const targets = gestureStage.current?.getBoundingClientRect();
        const overTargets = targets && targets.width > 0 && event.clientY >= targets.top && event.clientY <= targets.bottom;
        const next = overTargets
            ? event.clientX < targets.left + targets.width / 2 ? 'cancel' : 'edit'
            : dx <= -64 ? 'cancel' : dx >= 64 ? 'edit' : 'send';
        if (!current.started && Math.hypot(dx, current.y - event.clientY) > 12) { clearTimer(); gesture.current = null; return; }
        if (current.started && next !== current.intent) { current.intent = next; setIntent(next); }
    });
    const up = useEvent((event: PointerEvent) => {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        clearTimer();
        if (error || status === 'failed') { cancel(); return; }
        gesture.current = null;
        setHeld(false);
        if (!current.started) containerRef.current?.querySelector('textarea')?.focus();
        else if (current.intent === 'cancel') void dictation.cancelDictation();
        else {
            action.current = current.intent === 'edit' ? 'insert' : 'send';
            if (current.intent === 'edit') containerRef.current?.querySelector('textarea')?.focus();
            void dictation.confirmDictation();
        }
    });
    const interrupted = useEvent((event: PointerEvent) => { if (gesture.current?.pointer === event.pointerId) cancel(); });
    const preventEmptyInputSelection = useEvent((event: Event) => {
        if (emptyInputForTarget(event.target)) event.preventDefault();
    });
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
        container.addEventListener('pointerdown', down, true);
        container.addEventListener('touchstart', preventEmptyInputSelection, { capture: true, passive: false });
        window.addEventListener('pointermove', move, { capture: true, passive: false });
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', interrupted, true);
        container.addEventListener('contextmenu', preventEmptyInputSelection, true);
        container.addEventListener('selectstart', preventEmptyInputSelection, true);
        window.addEventListener('blur', cancel);
        document.addEventListener('visibilitychange', hidden);
        return () => {
            clearTimer();
            container.removeEventListener('pointerdown', down, true);
            container.removeEventListener('touchstart', preventEmptyInputSelection, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', interrupted, true);
            container.removeEventListener('contextmenu', preventEmptyInputSelection, true);
            container.removeEventListener('selectstart', preventEmptyInputSelection, true);
            window.removeEventListener('blur', cancel);
            document.removeEventListener('visibilitychange', hidden);
        };
    }, [containerRef, down, move, up, interrupted, cancel, clearTimer, preventEmptyInputSelection]);
    useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);

    if (!held && status === 'idle' && !error) return null;
    const energy = Math.pow(Math.min(1, Math.max(0, volume)), 0.6);
    return createPortal(
        <div className="oc-speech-overlay" data-intent={intent} data-error={Boolean(error)} onClick={error ? cancel : undefined} style={{ ...speechPalette, '--speech-energy': energy } as CSSProperties}>
            <div className="oc-speech-light-field" aria-hidden="true">
                {['ice', 'lilac', 'mint', 'blush', 'mid', 'core'].map((tone) => <div key={tone} className={`oc-speech-reactor oc-speech-reactor--${tone}`}><div className="oc-speech-light" /></div>)}
            </div>
            <div className="oc-speech-content">
                {error ? <p role="alert" className="oc-speech-caption oc-speech-error">{error}</p> : <div role="status" aria-live="polite" aria-atomic="true" className="oc-speech-caption">
                    {partialTranscript ? <span className="oc-speech-interim">{partialTranscript}</span> : t(status === 'uploading' ? 'chat.dictation.processing' : 'chat.dictation.listening')}
                </div>}
                {!error && status === 'uploading' && <div className="oc-speech-actions">
                    <Button variant="ghost" size="sm" onClick={cancel}>{t('chat.dictation.cancel')}</Button>
                </div>}
            </div>
            {held && <div className="oc-speech-gesture-stage" aria-hidden="true">
                <div className="oc-speech-gesture-surfaces">
                <div className="oc-speech-target-glass" style={{ clipPath: `url(#${cancelClipId})` }} />
                <div className="oc-speech-target-glass" style={{ clipPath: `url(#${editClipId})` }} />
                <svg className="oc-speech-geometry" viewBox="0 0 400 226" focusable="false">
                    <defs>
                    <clipPath id={cancelClipId} clipPathUnits="objectBoundingBox"><path transform="scale(0.0025 0.004424778761)" d={cancelTargetPath} /></clipPath>
                    <clipPath id={editClipId} clipPathUnits="objectBoundingBox"><path transform="scale(0.0025 0.004424778761)" d={editTargetPath} /></clipPath>
                    <linearGradient id={arcGradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" className="oc-speech-arc-top" />
                        <stop offset="100%" className="oc-speech-arc-bottom" />
                    </linearGradient></defs>
                    {/* All three arcs share (200, 620); target radii are 600/524 and the lower radius is 500. */}
                    <g className="oc-speech-targets" ref={gestureStage}>
                        <g className="oc-speech-target oc-speech-target--cancel" data-active={intent === 'cancel'}>
                            <path d={cancelTargetPath} />
                            <text x="95" y="68" textAnchor="middle" dominantBaseline="central" transform="rotate(-11 95 68)">{t('chat.dictation.cancelGesture')}</text>
                        </g>
                        <g className="oc-speech-target oc-speech-target--edit" data-active={intent === 'edit'}>
                            <path d={editTargetPath} />
                            <text x="305" y="68" textAnchor="middle" dominantBaseline="central" transform="rotate(11 305 68)">{t('chat.dictation.edit')}</text>
                        </g>
                    </g>
                    <path className="oc-speech-hold-arc" fill={`url(#${arcGradientId})`} d="M-50 186.987 A500 500 0 0 1 450 186.987 L450 300 H-50 Z" />
                </svg>
                </div>
            </div>}
        </div>, document.body,
    );
}
