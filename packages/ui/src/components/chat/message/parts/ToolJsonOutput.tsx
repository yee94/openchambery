import React from 'react';
import { useEvent } from '@reactuses/core';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

export const ToolJsonOutput: React.FC<{
    output: string;
    isMobile: boolean;
}> = ({ output, isMobile }) => {
    const { t } = useI18n();
    const id = React.useId();
    const [open, setOpen] = React.useState(false);
    const preview = React.useMemo(() => output.slice(0, 240).replace(/\s+/g, ' ').trim(), [output]);
    const title = t('chat.toolPart.output');

    const copyOutput = useEvent(async () => {
        const result = await copyTextToClipboard(output);
        if (result.ok) {
            toast.success(t('chat.toolPart.copiedOutput'));
        } else {
            toast.error(t('chat.toolPart.copyOutputFailed'));
        }
    });

    const copyAction = (
        <Button variant="ghost" size="icon" onClick={copyOutput} aria-label={t('chat.toolPart.copyOutput')}>
            <Icon name="file-copy" className="size-4" />
        </Button>
    );
    const content = open ? (
        <div className="tool-output-surface overlay-scrollbar-container min-h-0 flex-1 overflow-auto p-2" data-tool-json-code>
            <WorkerHighlightedCode language="json" code={output} wrap />
        </div>
    ) : null;

    return (
        <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="tool-output-surface flex min-w-0 items-center gap-1 rounded-lg" data-tool-json-preview>
                <code className="typography-code min-w-0 flex-1 truncate text-muted-foreground">{preview}</code>
                <Button
                    size="icon"
                    onClick={() => setOpen(true)}
                    aria-label={t('chat.toolPart.showRawJson')}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    title={t('chat.toolPart.showRawJson')}
                >
                    <Icon name="code-box" className="size-4" />
                </Button>
            </div>
            {isMobile ? (
                <MobileResizableSheet
                    id={`tool-json-${id}`}
                    open={open}
                    onOpenChange={setOpen}
                    title={<span className="typography-ui-header font-semibold">{title}</span>}
                    ariaLabel={title}
                    closeAriaLabel={t('dialog.common.actions.close')}
                    resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
                    trailing={copyAction}
                >
                    {content}
                </MobileResizableSheet>
            ) : (
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogContent className="h-[85dvh] max-w-5xl gap-1 overflow-hidden p-2" showCloseButton={false}>
                        <div className="flex shrink-0 items-center gap-1">
                            <DialogTitle className="min-w-0 flex-1 px-1">{title}</DialogTitle>
                            {copyAction}
                            <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label={t('dialog.common.actions.close')}>
                                <Icon name="close" className="size-4" />
                            </Button>
                        </div>
                        {content}
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
};
