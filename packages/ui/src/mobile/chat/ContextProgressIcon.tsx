import { clampPercent, resolveUsageTone } from '@/lib/quota';
import { useI18n } from '@/lib/i18n';

export type ContextProgressIconProps = {
  percentage: number;
  pending?: boolean;
};

/** Circular context-usage ring for mobile chrome (header / floating actions). */
export function ContextProgressIcon({ percentage, pending = false }: ContextProgressIconProps) {
  const { t } = useI18n();
  const progressPct = pending ? 0 : clampPercent(percentage) ?? 0;
  const tone = resolveUsageTone(percentage);
  const progressColor = pending ? 'var(--surface-muted-foreground)' : tone === 'critical'
    ? 'var(--status-error)'
    : tone === 'warn'
      ? 'var(--status-warning)'
      : 'var(--status-success)';
  const size = 18;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-[18px] -rotate-90"
      role="progressbar"
      aria-label={t('contextUsage.aria.label')}
      aria-valuetext={pending ? t('contextUsage.pending') : undefined}
      aria-valuenow={pending ? undefined : Math.round(progressPct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--interactive-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={progressColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progressPct / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );
}
