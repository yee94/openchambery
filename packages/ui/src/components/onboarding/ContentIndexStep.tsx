import { Button } from '@/components/ui/button';
import { YuriLogo } from '@/components/ui/YuriLogo';
import { DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { SessionContentIndexStatus } from '@/queries/sessionContentSearchQueries';

type ContentIndexStepProps = {
  status?: SessionContentIndexStatus;
  statusError?: boolean;
  onContinueInBackground?: () => void;
};

export function ContentIndexStep({ status, statusError, onContinueInBackground }: ContentIndexStepProps) {
  const { t, locale } = useI18n();
  const total = status?.total ?? 0;
  const completed = status?.completed ?? 0;
  const failed = statusError || status?.phase === 'partial' || status?.phase === 'error';
  const progress = total > 0 ? Math.min(1, Math.max(0, completed / total)) : null;

  return (
    <div className="absolute inset-0 overflow-hidden" data-content-index-onboarding>
      <div className="absolute left-1/2 top-1/2 h-[120px] w-[120px] -translate-x-1/2 -translate-y-1/2">
        <YuriLogo width={120} height={120} className="block h-[120px] w-[120px] [&_path]:fill-[var(--splash-logo-fill,currentColor)]" />
        <div role="progressbar" aria-label={t('onboarding.index.title')}
          aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={total > 0 ? completed : undefined}
          aria-valuetext={t('commandPalette.index.progress', { completed, total })}
          className="pointer-events-none absolute -inset-9">
          <svg viewBox="0 0 192 192" fill="none" aria-hidden="true"
            className={`absolute inset-0 size-full -rotate-90 ${progress === null && !failed ? 'motion-safe:animate-spin motion-safe:[animation-duration:3s]' : ''}`}>
            <circle cx="96" cy="96" r="84" stroke="currentColor" strokeWidth="1.5" className="text-border" />
            <circle cx="96" cy="96" r="84" pathLength="100" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeDasharray="100" strokeDashoffset={100 - (progress ?? 0.22) * 100}
              className="text-foreground/80 motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700" />
            {progress !== null && progress > 0 && progress < 1 && (
              <g style={{ transform: `rotate(${progress * 360}deg)`, transformOrigin: '96px 96px' }}
                className="motion-safe:transition-transform motion-safe:duration-700">
                <circle cx="180" cy="96" r="3" fill="currentColor" className="text-foreground" />
              </g>
            )}
          </svg>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-[calc(50%+116px)] overflow-y-auto px-6 pb-6 text-center">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center">
          {progress !== null && (
            <span aria-hidden="true" className="mb-3 text-sm tabular-nums text-muted-foreground">
              {new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(progress)}
            </span>
          )}
          <header className="space-y-2.5" role="status" aria-live="polite">
            <DialogTitle className="tracking-tight" style={{ fontSize: '1.0625rem', fontWeight: 450 }}>
              {t('onboarding.index.title')}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {failed ? t('onboarding.index.retrying') : t('onboarding.index.description')}
            </DialogDescription>
          </header>
          <Button size="sm" className="mt-8 text-xs font-normal" onClick={onContinueInBackground}>
            {t('onboarding.index.background')}
          </Button>
        </div>
      </div>
    </div>
  );
}
