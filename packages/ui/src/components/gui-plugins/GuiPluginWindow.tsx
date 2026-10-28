import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';

export function GuiPluginWindow({ id, open, title, onClose, children }: {
  id: string;
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { isMobile } = useDeviceInfo();
  const { t } = useI18n();
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  if (isMobile) {
    return (
      <MobileResizableSheet id={id} open={open} onOpenChange={onOpenChange}
        title={title} ariaLabel={title} closeAriaLabel={t('guiPlugins.close')}
        resizeAriaLabel={t('guiPlugins.resize')} initiallyExpanded>
        {children}
      </MobileResizableSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80dvh] max-w-5xl flex-col overflow-hidden" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
