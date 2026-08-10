import * as React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { useDesktopHostSwitchPending } from '@/queries/desktopHostSwitchMutation';
import { getDesktopRuntimeSwitchRemainingMs } from './desktopRuntimeSwitchOverlayTiming';

type DesktopRuntimeSwitchOverlayProps = {
  transition: {
    epoch: number;
    startedAt: number;
  };
  ready: boolean;
};

export function DesktopRuntimeSwitchOverlay({ transition, ready }: DesktopRuntimeSwitchOverlayProps) {
  const { t } = useI18n();
  const mutationPending = useDesktopHostSwitchPending();
  const [completedEpoch, setCompletedEpoch] = React.useState(0);
  // Keep overlay through probe/switch mutation AND the post-endpoint reconnect
  // window (identity-change epoch). One shared surface for every entry point.
  const epochVisible = transition.epoch > completedEpoch;
  const visible = mutationPending || epochVisible;

  React.useEffect(() => {
    if (!epochVisible || mutationPending) return;
    const remainingMs = getDesktopRuntimeSwitchRemainingMs(transition.startedAt, Date.now(), ready);
    if (remainingMs === null) return;

    const timer = window.setTimeout(() => {
      setCompletedEpoch((current) => Math.max(current, transition.epoch));
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [epochVisible, mutationPending, ready, transition.epoch, transition.startedAt]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center overflow-hidden bg-background/95 px-6 backdrop-blur-xl"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
        <div className="absolute left-1/2 top-1/2 size-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--interactive-border)]/40" />
        <div className="absolute left-1/2 top-1/2 size-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--interactive-selection)]/10 blur-3xl" />
      </div>
      <div className="relative flex max-w-md animate-in flex-col items-center text-center fade-in zoom-in-95 duration-300 motion-reduce:animate-none">
        <div className="mb-7 flex size-28 items-center justify-center rounded-[2rem] border border-[var(--interactive-border)]/60 bg-[var(--surface-elevated)]/75 shadow-2xl shadow-background/40">
          <OpenChamberLogo width={76} height={76} isAnimated />
        </div>
        <h1 className="typography-title text-foreground">{t('desktopHostSwitcher.transition.title')}</h1>
        <p className="mt-2 typography-body text-muted-foreground">{t('desktopHostSwitcher.transition.description')}</p>
        <div className="mt-7 h-1 w-28 overflow-hidden rounded-full bg-[var(--surface-muted)]" aria-hidden="true">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--status-info)] motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
