import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useI18n } from '@/lib/i18n';

const ATTACH_PICK_ROW_CLASS = 'h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0';

type MobileAttachPickSheetProps = {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
};

/** Android half-sheet that chooses photos vs files before the system picker opens. */
export const MobileAttachPickSheet: React.FC<MobileAttachPickSheetProps> = ({
  id,
  open,
  onOpenChange,
  onPickPhotos,
  onPickFiles,
}) => {
  const { t } = useI18n();

  return (
    <MobileResizableSheet
      id={id}
      open={open}
      onOpenChange={onOpenChange}
      title={<h2 className="truncate typography-ui-label font-semibold">{t('chat.chatInput.actions.addAttachment')}</h2>}
      ariaLabel={t('chat.chatInput.actions.addAttachment')}
      closeAriaLabel={t('mobile.surface.closeAria')}
      resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
      fitContent
    >
      <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3 pb-3">
        <div
          className="overflow-hidden rounded-2xl bg-[var(--surface-muted)]"
          data-page-scroll-lock="true"
        >
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className={ATTACH_PICK_ROW_CLASS}
            data-mobile-press-feedback="none"
            onClick={onPickPhotos}
          >
            <Icon name="file-image" className="size-5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate">{t('chat.chatInput.actions.attachPhotos')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className={ATTACH_PICK_ROW_CLASS}
            data-mobile-press-feedback="none"
            onClick={onPickFiles}
          >
            <Icon name="attachment-2" className="size-5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate">{t('chat.chatInput.actions.attachFiles')}</span>
          </Button>
        </div>
      </div>
    </MobileResizableSheet>
  );
};
