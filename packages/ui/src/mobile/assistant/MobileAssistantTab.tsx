import { useEvent } from '@reactuses/core';

import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAssistantCapabilityQuery, useAssistantSnapshotQuery } from '@/queries/assistantQueries';

import { MobileFloatingSurface, MobileLabeledSurfaceGroup, MobileTabPageScaffold } from '../MobileSurface';

export type MobileAssistantTabProps = {
  onEnable: () => void;
  onOpenAssistant: (assistantID: string) => void;
  className?: string;
};

function MobileAssistantSkeleton() {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 p-5"
      aria-busy="true"
      aria-label={t('assistants.state.unavailable')}
    >
      <div className="h-10 w-10 animate-pulse rounded-xl bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="mt-2 h-4 w-2/3 animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="h-3.5 w-full animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="h-3.5 w-4/5 animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
    </div>
  );
}

export function MobileAssistantTab({ onEnable, onOpenAssistant, className }: MobileAssistantTabProps) {
  const { t } = useI18n();
  const capability = useAssistantCapabilityQuery();
  const snapshot = useAssistantSnapshotQuery();
  const handleEnable = useEvent(() => onEnable());
  const handleOpenAssistant = useEvent((assistantID: string) => onOpenAssistant(assistantID));
  const pageTitle = t('assistants.title');

  if (capability.isPending || (capability.data?.supported && capability.data.enabled && snapshot.isPending)) {
    return (
      <MobileTabPageScaffold title={pageTitle} className={className} surface={false}>
        <MobileFloatingSurface className="oc-mobile-assistant-loading">
          <MobileAssistantSkeleton />
        </MobileFloatingSurface>
      </MobileTabPageScaffold>
    );
  }

  if (capability.data?.supported && capability.data.enabled && snapshot.data?.enabled && snapshot.data.assistants.length > 0) {
    return (
      <MobileTabPageScaffold title={pageTitle} className={className} surface={false} scrollsWithPage>
        <div
          className="oc-mobile-assistant-catalog"
          role="listbox"
          aria-label={t('assistants.listAria')}
        >
          {snapshot.data.assistants.map((assistant) => {
            const presentation = getAssistantPresentation(assistant.name);
            const displayName = presentation.displayName || assistant.name;
            const modeLabel = assistant.mode === 'stateless'
              ? t('assistants.mode.stateless')
              : t('assistants.mode.continuous');
            const summary = assistant.defaultPrompt.trim() || (assistant.mode === 'stateless'
              ? t('assistants.conversation.statelessHint')
              : t('assistants.conversation.continuousHint'));

            return (
              <MobileFloatingSurface key={assistant.id} className="oc-mobile-assistant-card-shell">
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  className={cn('oc-mobile-assistant-card', !assistant.enabled && 'opacity-65')}
                  onClick={() => handleOpenAssistant(assistant.id)}
                >
                  <span className="oc-mobile-assistant-avatar oc-mobile-glass-control rounded-full">
                    <AgentAvatar
                      name={assistant.id}
                      emoji={presentation.avatarEmoji}
                      size={28}
                      label={displayName}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="oc-mobile-entity-title block truncate font-semibold text-foreground">
                      {displayName}
                    </span>
                    <span className="oc-mobile-entity-meta mt-0.5 flex min-w-0 items-center text-muted-foreground">
                      <span className="shrink-0">{modeLabel}</span>
                      <span aria-hidden className="text-muted-foreground/50">·</span>
                      <span className="min-w-0 truncate">{summary}</span>
                    </span>
                  </span>
                  <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </MobileFloatingSurface>
            );
          })}
        </div>
      </MobileTabPageScaffold>
    );
  }

  const unsupported = capability.isSuccess && capability.data.supported === false;
  const unavailable = capability.isError || snapshot.isError;
  const title = unavailable
    ? t('assistants.state.unavailable')
    : unsupported
      ? t('assistants.state.unsupportedTitle')
      : t('assistants.state.instanceDisabled');

  return (
    <MobileTabPageScaffold
      title={pageTitle}
      className={className}
      surface={false}
      surfaceClassName="oc-mobile-assistant-state"
    >
      <MobileLabeledSurfaceGroup
        label={<span className="oc-mobile-page-section-label">{pageTitle}</span>}
        cardClassName="oc-mobile-assistant-state-card"
      >
        <section className="w-full max-w-md py-2">
        <div className="flex size-12 items-center justify-center rounded-xl bg-interactive-selection text-interactive-selection-foreground">
          <Icon name={unsupported ? 'cloud-off' : 'sparkling'} weight="medium" className="size-5" />
        </div>
        <h2 className="mt-5 max-w-xs text-lg font-semibold leading-snug tracking-[-0.02em] text-foreground">
          {title}
        </h2>
        {unavailable ? null : (
          <p className="mt-2 max-w-sm typography-small leading-relaxed text-muted-foreground">
            {unsupported ? t('assistants.state.unsupportedDescription') : t('assistants.state.instanceDisabledDescription')}
          </p>
        )}
        {capability.data?.supported === true ? (
          <Button type="button" size="lg" className="mt-6 w-full" onClick={handleEnable}>
            <Icon name="settings-3" className="size-[18px]" />
            {/* TODO(locale): Add a dedicated mobile Assistant enable CTA key. */}
            {t('assistants.settings.instanceEnabled')}
          </Button>
        ) : null}
        </section>
      </MobileLabeledSurfaceGroup>
    </MobileTabPageScaffold>
  );
}
