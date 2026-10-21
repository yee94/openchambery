import React from 'react';
import { ChooserScreen } from './ChooserScreen';
import { LocalSetupScreen } from './LocalSetupScreen';
import { RecoveryScreen } from './RecoveryScreen';
import type { RecoveryVariant } from './DesktopConnectionRecovery';
import { Button } from '@/components/ui/button';
import { DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { SessionContentIndexStatus } from '@/queries/sessionContentSearchQueries';

export type OnboardingScreenMode = 'first-launch' | 'local-setup' | 'recovery' | 'content-index';

type OnboardingScreenProps = {
  /** Callback when user goes back from local-setup */
  onBack?: () => void;
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
  /** Screen mode to render */
  mode?: OnboardingScreenMode;
  /** Recovery variant (only used when mode is 'recovery') */
  recoveryVariant?: RecoveryVariant;
  /** Host URL for recovery context */
  recoveryHostUrl?: string;
  /** Host label for recovery context */
  recoveryHostLabel?: string;
  /** Callback when user enters local setup from recovery */
  onEnterLocalSetup?: () => void;
  /** Callback when user wants to switch to remote (first-launch only) */
  onChooseRemote?: () => void;
  indexStatus?: SessionContentIndexStatus;
  indexStatusError?: boolean;
  onContinueInBackground?: () => void;
};

export function OnboardingScreen({
  onBack,
  onCliAvailable,
  mode = 'first-launch',
  recoveryVariant = 'missing-default-host',
  recoveryHostUrl,
  recoveryHostLabel,
  onEnterLocalSetup,
  indexStatus,
  indexStatusError,
  onContinueInBackground,
}: OnboardingScreenProps) {
  const { t, locale } = useI18n();
  const [showRecoveryRemoteForm, setShowRecoveryRemoteForm] = React.useState(false);
  const [recoveryEnteredLocalSetup, setRecoveryEnteredLocalSetup] = React.useState(false);

  // Reset transient recovery subflow state when the flow identity changes, so
  // stale local-setup or remote-form views don't bleed across prop updates.
  React.useEffect(() => {
    setRecoveryEnteredLocalSetup(false);
    setShowRecoveryRemoteForm(false);
  }, [mode, recoveryVariant, recoveryHostUrl, recoveryHostLabel]);

  // Derive the effective mode: recovery → local-setup can fall through to the
  // existing local-setup branch instead of getting stuck behind the early return.
  const effectiveMode = recoveryEnteredLocalSetup ? 'local-setup' : mode;

  if (effectiveMode === 'content-index') {
    const total = indexStatus?.total ?? 0;
    const completed = indexStatus?.completed ?? 0;
    const failed = indexStatusError || indexStatus?.phase === 'partial' || indexStatus?.phase === 'error';
    const progress = total > 0 ? Math.min(1, Math.max(0, completed / total)) : null;
    return (
      <div className="flex h-full items-center justify-center p-6" data-content-index-onboarding>
        <div className="flex w-full max-w-xs flex-col items-center text-center">
          <div role="progressbar" aria-label={t('onboarding.index.title')}
            aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={total > 0 ? completed : undefined}
            aria-valuetext={t('commandPalette.index.progress', { completed, total })}
            className="relative mb-7 flex size-24 items-center justify-center">
            <svg viewBox="0 0 96 96" fill="none" aria-hidden="true"
              className={`absolute inset-0 size-full -rotate-90 ${progress === null && !failed ? 'motion-safe:animate-spin motion-safe:[animation-duration:3s]' : ''}`}>
              <circle cx="48" cy="48" r="44" stroke="currentColor" strokeWidth="1.5" className="text-border" />
              <circle cx="48" cy="48" r="44" pathLength="100" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                strokeDasharray={`${progress === null ? 22 : progress * 100} 100`}
                className="text-foreground/70 motion-safe:transition-[stroke-dasharray] motion-safe:duration-700" />
            </svg>
            {progress !== null && <span aria-hidden="true" className="text-lg font-light tabular-nums tracking-tight text-foreground/80">
              {new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(progress)}
            </span>}
          </div>
          <header className="space-y-2" role="status" aria-live="polite">
            <DialogTitle className="text-base font-medium tracking-tight">{t('onboarding.index.title')}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {failed ? t('onboarding.index.retrying') : t('onboarding.index.description')}
            </DialogDescription>
          </header>
          <Button variant="ghost" size="sm" className="mt-8 text-xs font-normal text-muted-foreground" onClick={onContinueInBackground}>
            {t('onboarding.index.background')}
          </Button>
        </div>
      </div>
    );
  }

  // Recovery mode
  if (effectiveMode === 'recovery') {
    return (
      <RecoveryScreen
        variant={recoveryVariant}
        hostUrl={recoveryHostUrl}
        hostLabel={recoveryHostLabel}
        showRemoteForm={showRecoveryRemoteForm}
        onCloseRemoteForm={() => setShowRecoveryRemoteForm(false)}
        onSwitchToLocalFromRemote={() => {
          setShowRecoveryRemoteForm(false);
          setRecoveryEnteredLocalSetup(true);
        }}
        onEnterLocalSetup={() => {
          setRecoveryEnteredLocalSetup(true);
          onEnterLocalSetup?.();
        }}
      />
    );
  }

  // Local-setup mode
  if (effectiveMode === 'local-setup') {
    return (
      <LocalSetupScreen
        onBack={() => {
          if (recoveryEnteredLocalSetup) {
            setRecoveryEnteredLocalSetup(false);
          } else {
            onBack?.();
          }
        }}
        onCliAvailable={onCliAvailable}
        isFromRecovery={recoveryEnteredLocalSetup}
        onSwitchToRemote={() => setShowRecoveryRemoteForm(true)}
      />
    );
  }

  // First-launch mode (default)
  return (
    <ChooserScreen
      onCliAvailable={onCliAvailable}
    />
  );
}
