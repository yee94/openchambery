import React from 'react';
import { useEvent, useLocalStorage } from '@reactuses/core';
import androidDirectShareImage from '@/assets/assistant-share-welcome/android-direct-share.jpg';
import iosShareSheetImage from '@/assets/assistant-share-welcome/ios-share-sheet.jpg';
import selectAssistantImage from '@/assets/assistant-share-welcome/select-assistant.jpg';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

const ASSISTANT_SHARE_WELCOME_STORAGE_KEY = 'openchamber:assistant-share-welcome:v1';

const shareExamples = [
  { image: iosShareSheetImage, titleKey: 'assistants.shareWelcome.example.chat.title', descriptionKey: 'assistants.shareWelcome.example.chat.description' },
  { image: androidDirectShareImage, titleKey: 'assistants.shareWelcome.example.article.title', descriptionKey: 'assistants.shareWelcome.example.article.description' },
  { image: selectAssistantImage, titleKey: 'assistants.shareWelcome.example.note.title', descriptionKey: 'assistants.shareWelcome.example.note.description' },
] as const;

type AssistantShareWelcomeProps = {
  /** Auto-open once on native first run when true and not dismissed. */
  enabled?: boolean;
  /** Controlled open for Settings "Learn more" and other re-entry points. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Education dialog for the Assistant system-share inbox. */
export const AssistantShareWelcome: React.FC<AssistantShareWelcomeProps> = ({
  enabled = false,
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useLocalStorage(ASSISTANT_SHARE_WELCOME_STORAGE_KEY, false);
  const controlled = open !== undefined;
  const dialogOpen = controlled ? open : enabled && dismissed !== true;

  const dismiss = useEvent(() => {
    if (!controlled) setDismissed(true);
    onOpenChange?.(false);
  });

  return (
    <Dialog open={dialogOpen} onOpenChange={(nextOpen) => { if (!nextOpen) dismiss(); else onOpenChange?.(true); }}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(100%,31rem)] max-w-none gap-0 overflow-hidden rounded-2xl border-border bg-[var(--surface-elevated)] p-0 sm:w-[min(calc(100%-3rem),44rem)] lg:w-[min(calc(100%-4rem),74rem)]"
        containerClassName="fixed inset-0 z-50 flex items-end justify-center px-0 pt-8 sm:items-center sm:p-6"
      >
        <DialogHeader className="flex-row items-start gap-3 px-5 pb-5 pt-6 text-left sm:gap-4 sm:px-8 sm:pb-6 sm:pt-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-interactive-selection text-interactive-selection-foreground sm:size-12">
            <Icon name="share-2" className="size-5" />
          </div>
          <div className="min-w-0 space-y-1.5 sm:space-y-2">
            <DialogTitle className="typography-ui-header text-left sm:text-3xl">{t('assistants.shareWelcome.title')}</DialogTitle>
            <DialogDescription className="typography-ui text-left leading-6 sm:max-w-3xl sm:text-base sm:leading-7">{t('assistants.shareWelcome.description')}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="overflow-hidden px-5 pb-5 sm:px-8 sm:pb-7">
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0" aria-label={t('assistants.shareWelcome.examplesAria')}>
            {shareExamples.map((example, index) => (
              <article key={example.titleKey} className="w-[min(78vw,19rem)] shrink-0 snap-center overflow-hidden rounded-xl border border-border bg-background lg:w-auto lg:min-w-0">
                <div className="relative overflow-hidden border-b border-border bg-muted">
                  <img src={example.image} alt="" className="h-72 w-full object-cover object-bottom lg:h-[min(38vh,23rem)]" />
                  <span aria-hidden="true" className="absolute left-3 top-3 flex size-7 items-center justify-center rounded-full bg-[var(--surface-elevated)] typography-meta font-semibold text-foreground shadow-sm">
                    {index + 1}
                  </span>
                </div>
                <div className="space-y-1 px-4 py-3.5 lg:min-h-25">
                  <h2 className="typography-ui-label font-semibold text-foreground">{t(example.titleKey)}</h2>
                  <p className="typography-meta leading-5 text-muted-foreground">{t(example.descriptionKey)}</p>
                </div>
              </article>
            ))}
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-4 sm:px-8 sm:py-5">
          <Button size="lg" className="w-full lg:mx-auto lg:w-72" onClick={dismiss}>
            {t('assistants.shareWelcome.action')}
            <Icon name="arrow-right-s" className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
