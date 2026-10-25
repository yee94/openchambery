import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { saveImageToDevice, type ImageSaveTarget } from '../imageSave';

/** Key by media/runtime identity so pending completions cannot affect another preview. */
export function MediaSaveButton({ target }: { target: ImageSaveTarget }) {
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
        <Button variant="ghost" size="icon" data-media-save={state}
            className="size-8 rounded-full [corner-shape:round] text-[var(--oc-media-preview-foreground)] hover:text-[var(--oc-media-preview-foreground)] hover:bg-[color-mix(in_srgb,var(--oc-media-preview-foreground)_12%,transparent)] disabled:opacity-100"
            aria-label={label} aria-busy={saving} disabled={saving || saved} onClick={save}>
            <Icon name={saving ? 'loader-4' : saved ? 'check' : 'download'}
                className={saving ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
        </Button>
        <span className="sr-only" role="status" aria-live="polite">
            {state === 'error' ? t(target.kind === 'video' ? 'filesView.toast.saveFailed' : 'chat.image.actions.saveFailed')
                : state === 'idle' ? '' : label}
        </span>
    </>;
}
