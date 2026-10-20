import { useEffect, useState } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useDictation } from '@/hooks/useDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';

export function DictationTestDialog({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const [transcript, setTranscript] = useState('');
    const [finished, setFinished] = useState(false);
    const dictation = useDictation({ onTranscript: setTranscript });
    const supported = isDictationCaptureSupported();
    const recording = dictation.status === 'recording';
    const processing = dictation.status === 'uploading';
    const failed = dictation.status === 'failed';
    const cancel = useEvent(() => {
        setFinished(false);
        setTranscript('');
        if (failed) dictation.discardFailedDictation();
        else void dictation.cancelDictation();
    });
    const close = useEvent(() => { cancel(); onClose(); });
    useEffect(() => subscribeRuntimeEndpointChanged(close), [close]);
    useEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') cancel();
    }, document);

    const text = dictation.partialTranscript || transcript;
    const statusText = !supported ? t('settings.voice.volcengine.recordingUnsupported')
        : finished && !recording && !processing && !dictation.error && !text ? t('settings.voice.volcengine.silence') : '';
    const primaryLabel = t(failed ? 'chat.dictation.retry' : recording
        ? 'settings.voice.volcengine.finishRecording' : processing
            ? 'chat.dictation.processing' : 'settings.voice.volcengine.startRecording');
    const activate = useEvent(() => {
        if (processing || !supported) return;
        if (failed) { void dictation.retryFailedDictation(); return; }
        if (recording) { setFinished(true); void dictation.confirmDictation(); return; }
        setTranscript(''); setFinished(false); void dictation.startDictation();
    });

    return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="h-[min(19rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-3xl sm:max-w-[22rem]">
            <DialogHeader className="items-center pt-2 text-center">
                <DialogTitle className="typography-ui-label font-medium">{t('settings.voice.volcengine.asrTest')}</DialogTitle>
                <DialogDescription className="sr-only">{t('settings.voice.volcengine.testHelp')}</DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto pt-3">
                <div className="relative flex size-36 shrink-0 items-center justify-center">
                    <svg viewBox="0 0 144 144" className="pointer-events-none absolute inset-0 size-full text-foreground" fill="none" aria-hidden="true">
                        <circle cx="72" cy="72" r="68" stroke="currentColor" strokeWidth="0.75" opacity="0.12" />
                        <circle cx="72" cy="72" r="59" stroke="currentColor" strokeWidth="0.75"
                            strokeDasharray="24 161.35" strokeLinecap="round" transform="rotate(-102 72 72)"
                            className={cn(recording && 'text-[var(--primary-base)]')} opacity={recording ? 0.5 : 0.18} />
                    </svg>
                    <Button variant="ghost" size="icon"
                        className={cn('relative size-28 max-h-full rounded-full !bg-transparent text-foreground shadow-none transition-transform duration-200 hover:scale-105 active:scale-95 motion-reduce:transform-none motion-reduce:transition-none', recording && 'text-[var(--primary-base)]')}
                        disabled={!supported || processing} aria-label={primaryLabel} aria-pressed={recording} onClick={activate}>
                        <Icon name={processing || failed ? 'refresh' : recording ? 'stop' : 'mic'}
                             className={cn('size-12', processing && 'animate-spin motion-reduce:animate-none')} />
                        <span className="sr-only">{primaryLabel}</span>
                    </Button>
                </div>
                <div className="flex h-12 w-full shrink-0 items-center justify-center overflow-hidden px-2">
                    {dictation.error
                        ? <p role="alert" className="max-h-full overflow-y-auto break-words text-center typography-meta text-[var(--status-error)]">{dictation.error}</p>
                        : <div role="log" aria-live="polite" title={text} className="line-clamp-2 max-h-full break-words text-center typography-ui-label leading-6 text-muted-foreground">
                            {text ? (recording && text.length > 80 ? `…${text.slice(-80)}` : text) : statusText || primaryLabel}
                        </div>}
                </div>
            </div>
        </DialogContent>
    </Dialog>;
}
