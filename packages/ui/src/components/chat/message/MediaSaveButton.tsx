import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { saveImageToDevice, type ImageSaveTarget } from '../imageSave';

/** Key by media/runtime identity so pending completions cannot affect another preview. */
export function MediaSaveButton({ target, isMobile }: { target: ImageSaveTarget; isMobile: boolean }) {
    const { t } = useI18n();
    const [state, setState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const request = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => request.current?.abort(), []);
    const save = useEvent(async () => {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setState('saving');
        try {
            await saveImageToDevice(target, controller.signal);
            if (!controller.signal.aborted) setState('saved');
        } catch (error) {
            if (controller.signal.aborted) return;
            request.current = null;
            setState(error instanceof DOMException && error.name === 'AbortError' ? 'idle' : 'error');
        }
    });
    const saving = state === 'saving';
    const saved = state === 'saved';
    const label = saving ? t('chat.image.actions.saving') : saved ? t('filesView.editor.saved')
        : t(target.kind === 'video' ? 'filesView.editor.saveFile' : 'chat.image.actions.saveImage');
    return <>
        <Button variant={isMobile ? 'ghost' : 'mobileGlass'} size={isMobile ? 'icon' : 'mobileIcon'} data-media-save={state}
            className="rounded-full [corner-shape:round] disabled:opacity-100"
            aria-label={label} aria-busy={saving} disabled={saving || saved} onClick={save}>
            {saving ? <Icon name="loader-4" className={`${isMobile ? 'size-5' : 'size-6'} motion-safe:animate-spin`} />
                : saved ? <Icon name="check" weight="medium" className={isMobile ? 'size-5' : 'size-6'} />
                : <Icon name="download-2-fill" className={isMobile ? 'size-5' : 'size-6'} />}
        </Button>
        <span className="sr-only" role="status" aria-live="polite">
            {state === 'error' ? t(target.kind === 'video' ? 'filesView.toast.saveFailed' : 'chat.image.actions.saveFailed')
                : state === 'idle' ? '' : label}
        </span>
    </>;
}
