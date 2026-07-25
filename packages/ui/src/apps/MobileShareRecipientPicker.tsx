import { useEvent } from '@reactuses/core';

import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import type { AssistantCatalogEntry } from '@/stores/useAssistantUIStore';

import type { NativeShareDraft } from './mobileShareDraftHandoff';

type MobileShareRecipientPickerProps = {
  draft: NativeShareDraft | null;
  entries: AssistantCatalogEntry[];
  busy: boolean;
  onSelect: (draft: NativeShareDraft, entry: AssistantCatalogEntry) => void;
  onCancel: (draft: NativeShareDraft) => void;
};

export function MobileShareRecipientPicker({ draft, entries, busy, onSelect, onCancel }: MobileShareRecipientPickerProps) {
  const { t } = useI18n();
  const handleCancel = useEvent(() => {
    if (draft && !busy) onCancel(draft);
  });
  const handleOpenChange = useEvent((open: boolean) => {
    if (!open) handleCancel();
  });
  const handleSelect = useEvent((entry: AssistantCatalogEntry) => {
    if (draft) onSelect(draft, entry);
  });

  return (
    <Dialog open={Boolean(draft)} onOpenChange={handleOpenChange}>
      <DialogContent
        className="h-[100dvh] max-h-none w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 bg-background p-0"
        containerClassName="items-stretch p-0"
        overlayClassName="bg-background"
        showCloseButton={false}
      >
        <MobileDetailNavigation
          title={t('assistants.shareWelcome.example.note.title')}
          backAriaLabel={t('settings.common.actions.cancel')}
          onBack={handleCancel}
          backDisabled={busy}
          overlay
        />
        {entries.length ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[calc(max(0.25rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height,3.5rem)+0.75rem)]" role="listbox" aria-label={t('assistants.listAria')}>
            {entries.map((entry) => {
              const presentation = getAssistantPresentation(entry.name);
              const displayName = presentation.displayName || entry.name;
              return (
                <button
                  key={`${entry.connectionKey}:${entry.assistantID}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  disabled={busy}
                  className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-4 text-left text-foreground transition-colors last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                  onClick={() => handleSelect(entry)}
                >
                  <AgentAvatar name={entry.avatarSeed} emoji={presentation.avatarEmoji} size={36} label={displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{displayName}</span>
                    <span className="block truncate typography-small text-muted-foreground">{entry.serverLabel}</span>
                  </span>
                  <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[calc(max(0.25rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height,3.5rem)+0.75rem)] typography-ui text-muted-foreground">
            {t('assistants.state.unavailable')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
