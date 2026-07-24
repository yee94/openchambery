import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { cn } from '@/lib/utils';
import { useAssistantCapabilityQuery } from '@/queries/assistantQueries';

import { MobileTabPageHeader } from '../MobileTabPageHeader';

const AssistantView = lazyWithChunkRecovery(() => import('@/components/assistants/AssistantView').then((module) => ({
  default: module.AssistantView,
})));

export type MobileAssistantTabProps = {
  onEnable: () => void;
  className?: string;
};

function MobileAssistantSkeleton() {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full min-h-[70dvh] flex-col"
      aria-busy="true"
      aria-label={t('assistants.state.unavailable')}
    >
      <div className="animate-pulse px-1 pb-6 pt-3 motion-reduce:animate-none">
        <div className="h-8 w-36 rounded-lg bg-[var(--surface-elevated)]" />
      </div>
      <div className="flex flex-1 flex-col gap-3 rounded-[28px] border border-border/40 bg-[var(--surface-elevated)]/70 p-5">
        <div className="h-12 w-12 animate-pulse rounded-[17px] bg-interactive-hover motion-reduce:animate-none" />
        <div className="mt-3 h-5 w-2/3 animate-pulse rounded-md bg-interactive-hover motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse rounded-md bg-interactive-hover motion-reduce:animate-none" />
        <div className="h-4 w-4/5 animate-pulse rounded-md bg-interactive-hover motion-reduce:animate-none" />
      </div>
    </div>
  );
}

export function MobileAssistantTab({ onEnable, className }: MobileAssistantTabProps) {
  const { t } = useI18n();
  const capability = useAssistantCapabilityQuery();
  const handleEnable = useEvent(() => onEnable());

  if (capability.isPending) {
    return <MobileAssistantSkeleton />;
  }

  if (capability.data?.supported && capability.data.enabled) {
    return (
      <div className={cn('-mx-4 h-full min-h-[70dvh] overflow-hidden', className)}>
        <React.Suspense fallback={<MobileAssistantSkeleton />}>
          <AssistantView />
        </React.Suspense>
      </div>
    );
  }

  const unsupported = capability.isSuccess && capability.data.supported === false;
  const unavailable = capability.isError;
  const title = unavailable
    ? t('assistants.state.unavailable')
    : unsupported
      ? t('assistants.state.unsupportedTitle')
      : t('assistants.state.instanceDisabled');

  return (
    <div className={cn('flex h-full min-h-[70dvh] flex-col', className)}>
      <MobileTabPageHeader title={t('assistants.title')} />
      <div className="flex min-h-0 flex-1 items-center justify-center pb-8">
        <section className="relative isolate w-full max-w-md overflow-hidden rounded-[30px] border border-border/60 bg-[color:color-mix(in_srgb,var(--surface-elevated)_88%,transparent)] px-6 py-8 shadow-[0_22px_60px_color-mix(in_srgb,var(--surface-foreground)_10%,transparent)] backdrop-blur-2xl supports-[corner-shape:squircle]:rounded-[72px]">
          <div className="pointer-events-none absolute -right-12 -top-16 -z-10 size-44 rounded-full bg-primary/10 blur-3xl" aria-hidden="true" />
          <div className="flex size-14 items-center justify-center rounded-[20px] border border-border/50 bg-interactive-selection text-interactive-selection-foreground shadow-sm supports-[corner-shape:squircle]:rounded-[42px]">
            <Icon name={unsupported ? 'cloud-off' : 'sparkling'} weight="medium" className="size-6" />
          </div>
          <h2 className="mt-7 max-w-xs text-[1.45rem] font-semibold leading-tight tracking-[-0.025em] text-foreground">
            {title}
          </h2>
          {unavailable ? null : (
            <p className="mt-3 max-w-sm typography-ui leading-relaxed text-muted-foreground">
              {unsupported ? t('assistants.state.unsupportedDescription') : t('assistants.state.instanceDisabledDescription')}
            </p>
          )}
          {capability.data?.supported === true ? (
            <Button type="button" size="lg" className="mt-7 min-h-11 w-full" onClick={handleEnable}>
              <Icon name="settings-3" className="size-[18px]" />
              {/* TODO(locale): Add a dedicated mobile Assistant enable CTA key. */}
              {t('assistants.settings.instanceEnabled')}
            </Button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
