import type { ReactNode } from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type MobileChatHeaderProps = {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onBack: () => void;
  onOpenMenu: () => void;
  trailing?: ReactNode;
  className?: string;
};

/** Floating, safe-area-aware navigation capsule for the mobile chat page. */
export function MobileChatHeader({
  title,
  subtitle,
  busy = false,
  onBack,
  onOpenMenu,
  trailing,
  className,
}: MobileChatHeaderProps) {
  const { t } = useI18n();
  const handleBack = useEvent(onBack);
  const handleOpenMenu = useEvent(onOpenMenu);

  return (
    <header
      className={cn(
        'pointer-events-none absolute inset-x-0 top-[max(0.625rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] z-30 px-3 animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none',
        className,
      )}
    >
      <div className="pointer-events-auto mx-auto grid min-h-14 w-full max-w-xl grid-cols-[minmax(2.75rem,1fr)_minmax(0,2fr)_minmax(2.75rem,1fr)] items-center gap-1 rounded-[26px] border border-border/60 bg-[color:color-mix(in_srgb,var(--surface-elevated)_88%,transparent)] p-1.5 shadow-[0_14px_40px_color-mix(in_srgb,var(--surface-foreground)_14%,transparent)] backdrop-blur-2xl supports-[corner-shape:squircle]:rounded-[64px]">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 rounded-full text-muted-foreground transition-transform duration-200 active:scale-[0.94] motion-reduce:transition-none"
          aria-label={t('header.actions.backAria')}
          onClick={handleBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </Button>

        <div className="min-w-0 px-1 text-center">
          <h1 className="truncate typography-ui-label font-semibold tracking-[-0.015em] text-foreground">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-0.5 flex min-w-0 items-center justify-center gap-1.5 typography-micro text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full bg-[var(--status-success)]',
                  busy && 'bg-[var(--status-info)] motion-safe:animate-pulse',
                )}
              />
              <span className="truncate">{subtitle}</span>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-11 items-center justify-end">
          {trailing}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 rounded-full text-muted-foreground transition-transform duration-200 active:scale-[0.94] motion-reduce:transition-none"
            aria-label={t('mobile.menu.titleAria')}
            onClick={handleOpenMenu}
          >
            <Icon name="more-2" className="size-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
