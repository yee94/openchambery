import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  deleteAssistant,
  fetchAssistantCapability,
  type AssistantDTO,
} from '@/queries/assistantQueries';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';

import { getAssistantPresentation } from './assistantPresentation';

// eslint-disable-next-line react-refresh/only-export-components -- Deletion orchestrator is asserted directly by AssistantUI tests.
export async function deleteAssistantEntry(assistant: AssistantDTO): Promise<void> {
  await deleteAssistant(assistant);
  const defaultShare = useAssistantUIStore.getState().defaultShareAssistant;
  if (defaultShare?.assistantID !== assistant.id) return;
  const capability = await fetchAssistantCapability();
  if (
    capability.serverInstanceID
    && defaultShare.serverInstanceID === capability.serverInstanceID
  ) {
    useAssistantUIStore.getState().setDefaultShareAssistant(null);
  }
}

export type AssistantDeleteConfirmDialogProps = {
  assistant: AssistantDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (assistantID: string) => void;
};

export function AssistantDeleteConfirmDialog({
  assistant,
  open,
  onOpenChange,
  onDeleted,
}: AssistantDeleteConfirmDialogProps) {
  const { t } = useI18n();
  const [pending, setPending] = React.useState(false);
  const displayName = assistant
    ? (getAssistantPresentation(assistant.name).displayName || assistant.name)
    : '';

  const handleOpenChange = useEvent((next: boolean) => {
    if (pending && !next) return;
    onOpenChange(next);
  });

  const handleCancel = useEvent(() => {
    if (pending) return;
    onOpenChange(false);
  });

  const handleConfirm = useEvent(async () => {
    if (!assistant || pending) return;
    setPending(true);
    try {
      await deleteAssistantEntry(assistant);
      onDeleted?.(assistant.id);
      onOpenChange(false);
      toast.success(t('assistants.settings.toast.deleted'));
    } catch {
      toast.error(t('assistants.settings.toast.deleteFailed'));
    } finally {
      setPending(false);
    }
  });

  return (
    <Dialog open={open && assistant !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('assistants.settings.delete')}</DialogTitle>
          <DialogDescription>
            {t('assistants.settings.deleteConfirm', { name: displayName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={handleCancel} disabled={pending}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleConfirm} disabled={pending}>
            {t('settings.common.actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
