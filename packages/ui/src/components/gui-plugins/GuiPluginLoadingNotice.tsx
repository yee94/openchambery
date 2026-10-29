import React from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { afterGuiPaint } from '@/lib/gui-plugins/scheduling';

export function GuiPluginLoadingNotice({ pending, error, inventory }: {
  pending: boolean;
  error: string | null;
  inventory: readonly { id: string; error?: string }[];
}) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [dismissed, setDismissed] = React.useState(false);
  const [paintedPending, setPaintedPending] = React.useState(false);
  React.useEffect(() => {
    if (!pending || dismissed) { setPaintedPending(false); return; }
    const controller = new AbortController();
    void afterGuiPaint(controller.signal).then(() => {
      if (!controller.signal.aborted) setPaintedPending(true);
    }).catch(() => {});
    return () => controller.abort();
  }, [pending, dismissed]);
  const reported = React.useRef(new Set<string>());
  React.useEffect(() => {
    const errors = [error, ...inventory.map((plugin) => plugin.error ? `${plugin.id}: ${plugin.error}` : null)].filter((value): value is string => Boolean(value));
    for (const detail of errors) {
      if (!reported.current.has(detail)) toast.error(t('guiPlugins.failed'), { description: detail });
    }
    reported.current = new Set(errors);
  }, [error, inventory, t]);
  const open = pending && paintedPending && !dismissed;
  const onOpenChange = (next: boolean) => { if (!next) setDismissed(true); };
  const title = t('guiPlugins.loadingNecessary');
  const action = <Button onClick={() => setDismissed(true)}>{t('guiPlugins.continueBackground')}</Button>;
  if (isMobile) return <MobileResizableSheet id="gui-plugin-loading" open={open} onOpenChange={onOpenChange} fitContent
    title={title} ariaLabel={title} closeAriaLabel={t('guiPlugins.close')} resizeAriaLabel={t('guiPlugins.resize')}>
    <div className="flex justify-end p-4">{action}</div>
  </MobileResizableSheet>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="flex justify-end">{action}</div>
    </DialogContent>
  </Dialog>;
}
