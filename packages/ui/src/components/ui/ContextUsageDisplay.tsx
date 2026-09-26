import React from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { clampPercent, resolveUsageTone } from '@/lib/quota';

interface ContextUsageDisplayProps {
  pending?: boolean;
  totalTokens: number;
  percentage: number;
  colorPercentage?: number;
  contextLimit: number;
  outputLimit?: number;
  size?: 'default' | 'compact';
  isMobile?: boolean;
  hideIcon?: boolean;
  showPercentIcon?: boolean;
  /**
   * Subtle chrome: muted ring at rest; reveal percent + used/limit on hover
   * or while the context panel is open (`pressed`). Click still opens the panel.
   */
  appearance?: 'default' | 'subtle';
  className?: string;
  valueClassName?: string;
  percentIconClassName?: string;
  onClick?: () => void;
  pressed?: boolean;
}

export const ContextUsageDisplay: React.FC<ContextUsageDisplayProps> = ({
  pending = false,
  totalTokens,
  percentage,
  colorPercentage,
  contextLimit,
  outputLimit,
  size = 'default',
  isMobile = false,
  hideIcon = false,
  showPercentIcon = false,
  appearance = 'default',
  className,
  valueClassName,
  percentIconClassName,
  onClick,
  pressed = false,
}) => {
  const { t } = useI18n();
  const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState(false);
  const colorPct = typeof colorPercentage === 'number' ? colorPercentage : percentage;
  const progressPct = pending ? 0 : clampPercent(percentage) ?? 0;
  const isSubtle = appearance === 'subtle';
  const progressTone = resolveUsageTone(colorPct);
  const progressColor = isSubtle || pending
    ? 'var(--surface-muted-foreground)'
    : progressTone === 'critical'
      ? 'var(--status-error)'
      : progressTone === 'warn'
        ? 'var(--status-warning)'
        : 'var(--status-success)';

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toFixed(1).replace(/\.0$/, '');
  };

  const getPercentageColor = (pct: number) => {
    if (pending) return 'text-muted-foreground';
    if (pct >= 90) return 'text-status-error';
    if (pct >= 75) return 'text-status-warning';
    return 'text-status-success';
  };

  const circularProgressSize = isSubtle ? 18 : 20;
  const circularProgressStroke = isSubtle ? 2 : 3;
  const circularProgressRadius = (circularProgressSize - circularProgressStroke) / 2;
  const circularProgressCircumference = 2 * Math.PI * circularProgressRadius;
  const circularProgressOffset = circularProgressCircumference * (1 - progressPct / 100);

  const safeOutputLimit = typeof outputLimit === 'number' ? Math.max(outputLimit, 0) : 0;
  const usagePercentLabel = pending ? t('contextUsage.pending') : `${Math.min(percentage, 999).toFixed(1)}%`;
  const usedTokensLabel = pending ? '—' : formatTokens(totalTokens);
  const contextLimitLabel = formatTokens(contextLimit);
  const tooltipLines = pending ? [t('contextUsage.pendingDescription')] : [
    t('contextUsage.tooltip.usage', { percent: usagePercentLabel }),
    t('contextUsage.tooltip.usedOfLimit', {
      used: usedTokensLabel,
      limit: contextLimitLabel,
    }),
    t('contextUsage.tooltip.outputLimit', { tokens: formatTokens(safeOutputLimit) }),
  ];

  const isInteractive = !isMobile && typeof onClick === 'function';

  const progressRing = (
    <svg
      viewBox={`0 0 ${circularProgressSize} ${circularProgressSize}`}
      className={cn(
        isSubtle ? 'h-4 w-4 shrink-0 -rotate-90 text-muted-foreground/70' : 'h-3.5 w-3.5 -rotate-90',
        percentIconClassName,
      )}
      role="progressbar"
      aria-label={t('contextUsage.aria.label')}
      aria-valuetext={pending ? t('contextUsage.pending') : undefined}
      aria-valuenow={pending ? undefined : Math.round(progressPct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle
        cx={circularProgressSize / 2}
        cy={circularProgressSize / 2}
        r={circularProgressRadius}
        fill="none"
        stroke="var(--interactive-border)"
        strokeWidth={circularProgressStroke}
      />
      <circle
        cx={circularProgressSize / 2}
        cy={circularProgressSize / 2}
        r={circularProgressRadius}
        fill="none"
        stroke={progressColor}
        strokeWidth={circularProgressStroke}
        strokeLinecap="round"
        strokeDasharray={circularProgressCircumference}
        strokeDashoffset={circularProgressOffset}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );

  // Subtle: ring only at rest; reveal % + used/limit on hover or while the panel is open.
  const subtleDetails = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 overflow-hidden whitespace-nowrap typography-micro font-medium text-foreground transition-[max-width,opacity,margin] duration-200',
        pressed || pending
          ? 'ml-1 max-w-[14rem] opacity-100'
          : 'ml-0 max-w-0 opacity-0 group-hover:ml-1 group-hover:max-w-[14rem] group-hover:opacity-100 group-focus-visible:ml-1 group-focus-visible:max-w-[14rem] group-focus-visible:opacity-100',
      )}
    >
      <span>{usagePercentLabel}</span>
      <span className="text-muted-foreground">
        {usedTokensLabel}
        <span className="mx-0.5 text-muted-foreground/60">/</span>
        {contextLimitLabel}
      </span>
    </span>
  );

  const contextContent = isSubtle ? (
    <>
      {progressRing}
      {subtleDetails}
    </>
  ) : (
    <>
      {!isMobile && !hideIcon && <Icon name="donut-chart" className="h-4 w-4 flex-shrink-0" />}
      <span className={cn('font-medium inline-flex items-center gap-1.5', valueClassName)}>
        {pending ? (
          <>
            {showPercentIcon && progressRing}
            <span className="text-muted-foreground">{usagePercentLabel}</span>
          </>
        ) : showPercentIcon ? (
          <>
            {progressRing}
            <span className="text-foreground">{usagePercentLabel}</span>
          </>
        ) : (
          <>
            <span className={getPercentageColor(colorPct)}>{Math.min(percentage, 999).toFixed(1)}</span>%
          </>
        )}
      </span>
    </>
  );

  const sharedClassName = cn(
    'app-region-no-drag flex items-center gap-1.5 select-none',
    size === 'compact' ? 'typography-micro' : 'typography-meta',
    isInteractive
      ? cn(
        'group rounded-md text-foreground transition-colors',
        isSubtle
          ? cn(
            'p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50',
            pressed && 'bg-interactive-hover/50 text-foreground',
          )
          : 'px-2 py-1.5 hover:bg-interactive-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
      )
      : 'text-muted-foreground/60',
    className,
  );

  const contextElement = isInteractive ? (
    <button
      type="button"
      className={sharedClassName}
      aria-label={t('contextUsage.aria.label')}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {contextContent}
    </button>
  ) : (
    <div
      className={sharedClassName}
      aria-label={t('contextUsage.aria.label')}
      onClick={isMobile ? () => setMobileTooltipOpen(true) : undefined}
    >
      {contextContent}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {contextElement}
        <MobileOverlayPanel
          open={mobileTooltipOpen}
          onClose={() => setMobileTooltipOpen(false)}
          title={t('contextUsage.mobile.title')}
        >
          <div className="flex flex-col gap-1.5">
            <div className="rounded-xl border border-border/40 bg-sidebar/30 px-3 py-2 space-y-1">
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usedTokens')}</span>
                <span className="typography-meta text-foreground font-medium">{usedTokensLabel}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.contextLimit')}</span>
                <span className="typography-meta text-foreground font-medium">{contextLimitLabel}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.outputLimit')}</span>
                <span className="typography-meta text-foreground font-medium">{formatTokens(safeOutputLimit)}</span>
              </div>
              <div className="flex justify-between items-center pt-1 border-t border-border/40">
                <span className="typography-meta text-muted-foreground">{t('contextUsage.mobile.usage')}</span>
                <span className={cn('typography-meta font-semibold', getPercentageColor(colorPct))}>
                  {usagePercentLabel}
                </span>
              </div>
            </div>
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  // Subtle already reveals % + used/limit inline on hover / while open — skip the
  // floating tooltip so it does not cover those values.
  if (isSubtle) {
    return contextElement;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{contextElement}</TooltipTrigger>
      <TooltipContent>
        <div className="space-y-0.5">
          {tooltipLines.map((line) => (
            <p key={line} className="typography-micro leading-tight">
              {line}
            </p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
