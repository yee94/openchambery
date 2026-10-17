import React from 'react';
import { useInterval } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import type { UsageWindow } from '@/types';
import { formatQuotaValueLabel, formatQuotaResetLabel, formatWindowLabel, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { UsageProgressBar } from './UsageProgressBar';
import { PaceIndicator } from './PaceIndicator';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';

interface UsageCardProps {
  title: string;
  window: UsageWindow;
  subtitle?: string | null;
  showToggle?: boolean;
  toggleEnabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

export const UsageCard: React.FC<UsageCardProps> = ({
  title,
  window,
  subtitle,
  showToggle = false,
  toggleEnabled = false,
  onToggle,
}) => {
  const { locale } = useI18n();
  const [now, setNow] = React.useState(Date.now);
  useInterval(() => setNow(Date.now()), window.disablePace && window.resetAt ? 30000 : null);
  const minutes = window.resetAt ? Math.max(0, Math.ceil((window.resetAt - now) / 60000)) : null;
  const countdown = minutes === null ? '' : [
    { unit: 'day', value: Math.floor(minutes / 1440) },
    { unit: 'hour', value: Math.floor((minutes % 1440) / 60) },
    { unit: 'minute', value: minutes % 60 },
  ].filter(({ unit, value }) => value > 0 || (unit === 'minute' && minutes === 0))
    .map(({ unit, value }) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value))
    .join(' ');
  const displayMode = useQuotaStore((state) => state.displayMode);
  const showPredValues = useQuotaStore((state) => state.showPredValues);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const displayPercent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
  const barLabel = displayMode === 'remaining' ? 'remaining' : 'used';
  const percentLabel = window.disablePace && window.valueLabel && displayPercent !== null
    ? `${formatQuotaValueLabel(null, displayPercent)} · ${window.valueLabel}`
    : formatQuotaValueLabel(window.valueLabel, displayPercent);
  const resetLabel = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
  const windowLabel = formatWindowLabel(title);

  const paceInfo = React.useMemo(() => {
    return window.disablePace ? null : calculatePace(window.usedPercent, window.resetAt, window.windowSeconds, title);
  }, [window.usedPercent, window.resetAt, window.windowSeconds, window.disablePace, title]);

  const expectedMarkerPercent = React.useMemo(() => {
    if (!paceInfo || paceInfo.dailyAllocationPercent === null) {
      return null;
    }
    const expectedUsed = calculateExpectedUsagePercent(paceInfo.elapsedRatio);
    return displayMode === 'remaining' ? 100 - expectedUsed : expectedUsed;
  }, [paceInfo, displayMode]);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {showToggle && (
            <Checkbox
              checked={toggleEnabled}
              onChange={(checked) => onToggle?.(checked)}
              ariaLabel="Show in dropdown"
            />
          )}
          <div className="min-w-0 flex flex-col">
            <span className="typography-ui-label text-foreground truncate">{windowLabel}</span>
            {subtitle && (
              <span className="typography-meta text-muted-foreground truncate">{subtitle}</span>
            )}
          </div>
        </div>
        <div className="typography-ui-label text-foreground tabular-nums flex items-center justify-end">
          {percentLabel === '-' ? '' : percentLabel}
        </div>
      </div>

      {(!window.disablePace || displayPercent !== null || resetLabel) && <div className="mt-2.5">
        {(!window.disablePace || displayPercent !== null) &&
        <UsageProgressBar
          percent={displayPercent}
          tonePercent={window.usedPercent}
          expectedMarkerPercent={expectedMarkerPercent}
          className="h-1.5"
        />}
        <div className="mt-1 flex items-center justify-between">
          <span className="typography-micro text-muted-foreground">
            {resetLabel ? window.disablePace ? `${resetLabel} (${countdown})` : `Resets ${resetLabel}` : ''}
          </span>
          <span className="typography-micro text-muted-foreground">
            {window.disablePace && displayPercent === null ? '' : barLabel}
          </span>
        </div>
      </div>}

      {paceInfo && showPredValues && (
        <div className="mt-1.5">
          <PaceIndicator paceInfo={paceInfo} />
        </div>
      )}
    </div>
  );
};
