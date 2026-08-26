import React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { useMobileBackRoute } from '@/mobile/mobileBackNavigation';

import { bindImageSaveActionsOpen } from './imageSaveActionsBus';
import { saveImageToDevice, type ImageSaveTarget } from './imageSave';

/**
 * Single chat-tree host for long-press / context-menu image save actions.
 * Mount once under a chat surface that owns message and composer images.
 */
export function ImageSaveActionsHost() {
  const { t } = useI18n();
  const [target, setTarget] = React.useState<ImageSaveTarget | null>(null);
  const [saving, setSaving] = React.useState(false);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const open = Boolean(target);

  React.useEffect(() => bindImageSaveActionsOpen((next) => {
    setTarget(next);
    setSaving(false);
  }), []);

  const handleOpenChange = useEvent((nextOpen: boolean) => {
    if (!nextOpen) {
      setTarget(null);
      setSaving(false);
    }
  });

  useMobileBackRoute({
    id: 'image-save-actions',
    active: open,
    layer: 'overlay',
    onBack: () => {
      handleOpenChange(false);
      return true;
    },
    surfaceRef,
  });

  const handleSave = useEvent(async () => {
    if (!target || saving) return;
    setSaving(true);
    try {
      await saveImageToDevice(target);
      toast.success(t('chat.image.actions.saveSuccess'));
      setTarget(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setSaving(false);
        return;
      }
      toast.error(t('chat.image.actions.saveFailed'));
      setSaving(false);
      return;
    }
    setSaving(false);
  });

  if (!target) return null;

  const title = target.filename?.trim() || t('chat.image.actions.sheetTitle');
  const saveLabel = isCapacitorApp()
    ? t('chat.image.actions.saveToPhotos')
    : t('chat.image.actions.saveImage');

  return (
    <div ref={surfaceRef}>
      <MobileResizableSheet
        id="image-save-actions-sheet"
        open={open}
        onOpenChange={handleOpenChange}
        title={<h2 className="truncate typography-ui-label font-semibold">{title}</h2>}
        ariaLabel={title}
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
              className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
              data-mobile-press-feedback="none"
              disabled={saving}
              onClick={() => {
                void handleSave();
              }}
            >
              <Icon name={saving ? 'loader-4' : 'download'} className={saving ? 'size-5 animate-spin' : 'size-5'} />
              <span className="truncate">{saving ? t('chat.image.actions.saving') : saveLabel}</span>
            </Button>
          </div>
        </div>
      </MobileResizableSheet>
    </div>
  );
}
