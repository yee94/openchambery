import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import {
  formatQuotaResetLabel,
  formatQuotaValueLabel,
  formatWindowLabel,
  QUOTA_PROVIDERS,
} from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';
import type { QuotaProviderId, UsageWindow } from '@/types';

import { ContextProgressIcon } from './ContextProgressIcon';
import {
  buildMobileContextDisplay,
  getLatestAssistantTotalTokens,
  getLatestUserMessageModel,
  getNumericLimit,
  type MobileContextDisplay,
} from './mobileContextUsage';

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

type MobileUsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

type MobileUsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  rows: MobileUsageLimitRow[];
  status: string | null;
};

const getWindowValueClass = (window: UsageWindow): string => {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 'text-foreground';
  if (usedPercent >= 80) return 'text-[var(--status-error)]';
  if (usedPercent >= 50) return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const MetadataRow: React.FC<{
  iconNode?: React.ReactNode;
  iconName?: 'git-branch';
  label: string;
  children: React.ReactNode;
}> = ({ iconNode, iconName, label, children }) => (
  <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {iconNode ?? (iconName ? <Icon name={iconName} className="size-[18px]" /> : null)}
    </span>
    <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
      {children}
    </span>
  </div>
);

const MobileUsageLimits: React.FC<{
  groups: MobileUsageProviderGroup[];
  displayMode: 'usage' | 'remaining';
  isLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ groups, displayMode, isLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const modeLabel = displayMode === 'remaining' ? t('header.services.remaining') : t('header.services.used');

  if (groups.length === 0) return null;

  return (
    <div className="pt-2.5">
      <div className="flex min-w-0 items-center gap-3 px-2.5 pb-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name="timer" className="size-[18px]" />
        </span>
        <span className="shrink-0 typography-ui-label text-muted-foreground">
          {t('mobile.header.metadata.usage')}
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center justify-end gap-1.5 typography-ui-label text-muted-foreground">
          {isLoading ? <Icon name="refresh" className="size-3.5 animate-spin" /> : null}
          <span className="truncate">{modeLabel}</span>
        </span>
      </div>

      <div className="space-y-1.5">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
                {group.providerName}
              </span>
              {group.status && group.rows.length === 0 ? (
                <span className="shrink-0 truncate typography-micro text-muted-foreground">
                  {group.status}
                </span>
              ) : null}
            </div>
            {group.rows.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {group.rows.map((row) => {
                  const displayPercent = displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
                  const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
                  const resetLabel = formatQuotaResetLabel(
                    row.window.resetAt,
                    row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
                    timeFormatPreference,
                  );
                  return (
                    <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate typography-ui-label text-muted-foreground">
                          {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
                        </span>
                        {resetLabel ? (
                          <span className="shrink-0 truncate typography-micro text-muted-foreground/70">{resetLabel}</span>
                        ) : null}
                      </span>
                      <span className={cn('shrink-0 typography-ui-label font-semibold tabular-nums', getWindowValueClass(row.window))}>
                        {metricLabel === '-' ? '' : metricLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {group.status && group.rows.length > 0 ? (
              <div className="mt-1.5 typography-micro text-muted-foreground">{group.status}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const SessionMetadataOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  contextDisplay: MobileContextDisplay;
  branchLabel: string;
  usageGroups: MobileUsageProviderGroup[];
  usageDisplayMode: 'usage' | 'remaining';
  isUsageLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({
  open,
  onClose,
  anchorRef,
  contextDisplay,
  branchLabel,
  usageGroups,
  usageDisplayMode,
  isUsageLoading,
  timeFormatPreference,
}) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsExiting(false);
      return;
    }

    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!shouldRender) return null;

  // Dismiss layer starts below the header so the progress-ring trigger stays
  // hittable for re-tap close. Phone shells isolate stacking, so a full-screen
  // layer always wins over in-header z-index.
  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <button
        type="button"
        className="pointer-events-auto absolute inset-x-0 bottom-0 cursor-default top-[calc(var(--oc-safe-area-top,0px)+var(--oc-mobile-detail-navigation-height,3.5rem)+0.25rem)]"
        aria-label={t('mobile.surface.closeAria')}
        onPointerDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('mobile.header.openMetadataAria')}
        className={cn(
          'pointer-events-auto absolute inset-x-3 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-mobile-detail-navigation-height,3.5rem)+0.5rem)] overflow-y-auto overscroll-contain rounded-[20px] oc-mobile-overlay-surface oc-mobile-overlay-surface--translucent p-2 will-change-transform',
          isExiting && 'pointer-events-none',
        )}
        style={{
          animation: `${isExiting ? 'session-metadata-out' : 'session-metadata-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-mobile-detail-navigation-height, 3.5rem) - 1rem))',
        }}
        onPointerDown={(event) => {
          // Keep panel interactions from hitting the outside dismiss layer.
          event.stopPropagation();
        }}
      >
        <div className="space-y-1">
          <MetadataRow iconName="git-branch" label={t('mobile.header.metadata.branch')}>
            {branchLabel}
          </MetadataRow>
          {contextDisplay ? (
            <MetadataRow
              iconNode={<ContextProgressIcon percentage={contextDisplay.percentage} />}
              label={t('mobile.header.metadata.context')}
            >
              <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                <span className={cn('font-semibold', contextDisplay.colorClass)}>{contextDisplay.percentage.toFixed(1)}%</span>
                <span className="text-muted-foreground">{contextDisplay.tokens}</span>
              </span>
            </MetadataRow>
          ) : null}
          <MobileUsageLimits
            groups={usageGroups}
            displayMode={usageDisplayMode}
            isLoading={isUsageLoading}
            timeFormatPreference={timeFormatPreference}
          />
        </div>
      </div>
      <style>{`
        @keyframes session-metadata-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-metadata-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

export type MobileContextProgressButtonProps = {
  sessionId: string;
  /** Controlled open state when parent owns header elevation / mutual exclusion. */
  open?: boolean;
  /** Notify parent when the metadata panel opens so header stacking can elevate. */
  onOpenChange?: (open: boolean) => void;
};

/**
 * Floating glass context-usage ring for phone chat detail. Click opens the
 * session metadata panel (branch / context / provider quotas).
 */
export function MobileContextProgressButton({
  sessionId,
  open: openProp,
  onOpenChange,
}: MobileContextProgressButtonProps) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const isDraft = sessionId.length === 0;

  const setOpen = useEvent((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (!isControlled) setUncontrolledOpen(resolved);
    onOpenChange?.(resolved);
  });

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const sessionDirectory = useSessionUIStore((state) => (
    sessionId ? state.getDirectoryForSession(sessionId) : null
  ));
  const effectiveDirectory = sessionDirectory || currentDirectory;
  const gitDirectory = normalizePath(effectiveDirectory) || null;

  const activeSessionMessages = useSessionMessages(sessionId, effectiveDirectory || undefined);
  const isGitRepo = useIsGitRepo(gitDirectory);
  const gitStatus = useGitStatus(gitDirectory);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  useConfigStore((state) => state.modelsMetadata.size);
  const savedSessionModelSelector = React.useMemo(
    () => (state: ReturnType<typeof useSelectionStore.getState>) => (
      sessionId ? state.sessionModelSelections.get(sessionId) ?? null : null
    ),
    [sessionId],
  );
  const savedSessionModel = useSelectionStore(savedSessionModelSelector);
  const quotaResults = useQuotaStore((state) => state.results);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    setOpen(false);
  }, [sessionId, effectiveDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    void ensureStatus(gitDirectory, git);
  }, [ensureStatus, git, gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== gitDirectory) return;
      void fetchStatus(gitDirectory, git);
    });
  }, [fetchStatus, git, gitDirectory]);

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  React.useEffect(() => {
    preloadProviderLogos(dropdownProviderIds);
  }, [dropdownProviderIds]);

  React.useEffect(() => {
    if (!open || isQuotaLoading) return;
    const missingEnabledProvider = dropdownProviderIds.some((providerId) => (
      !quotaResults.some((result) => result.providerId === providerId)
    ));
    if (!missingEnabledProvider) return;
    void fetchAllQuotas();
  }, [dropdownProviderIds, fetchAllQuotas, isQuotaLoading, open, quotaResults]);

  const latestMessageModel = React.useMemo(
    () => getLatestUserMessageModel(activeSessionMessages),
    [activeSessionMessages],
  );

  const modelRef = latestMessageModel
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const provider = modelRef ? providers.find((entry) => entry.id === modelRef.providerID) : undefined;
  const liveModel = provider?.models.find((model) => model.id === modelRef?.modelID);
  const metadata = modelRef ? getModelMetadata(modelRef.providerID, modelRef.modelID) : undefined;
  const contextLimit = getNumericLimit((liveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? metadata?.limit?.context
    ?? 0;
  const totalTokens = React.useMemo(
    () => getLatestAssistantTotalTokens(activeSessionMessages),
    [activeSessionMessages],
  );

  const contextDisplay = buildMobileContextDisplay({
    totalTokens,
    contextLimit,
    isDraft,
  });

  const branchLabel = isGitRepo === true
    ? (gitStatus?.current?.trim() || t('gitView.branch.detachedHead'))
    : t('common.unavailable');

  const usageGroups = React.useMemo<MobileUsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return QUOTA_PROVIDERS
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => resultsByProvider.get(providerMeta.id)?.configured === true)
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id)!;
        const rows: MobileUsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({
            key: `window-${label}`,
            label: formatWindowLabel(label),
            window,
          });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

        const status = !result.ok && result.error
          ? result.error
          : rows.length === 0
            ? t('header.services.noRateLimitsReported')
            : null;

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, quotaResults, selectedQuotaModels, t]);

  React.useEffect(() => {
    if (!open || usageGroups.length === 0) return;
    preloadProviderLogos(usageGroups.map((group) => group.providerId));
  }, [open, usageGroups]);

  const handleToggle = useEvent(() => {
    setOpen((current) => !current);
  });

  const handleClose = useEvent(() => {
    setOpen(false);
  });

  return (
    <>
      <span ref={triggerRef} className="inline-flex">
        <Button
          type="button"
          variant="mobileGlass"
          size="mobileIcon"
          aria-label={t('mobile.header.openMetadataAria')}
          aria-expanded={open}
          onClick={handleToggle}
        >
          <ContextProgressIcon percentage={contextDisplay?.percentage ?? 0} />
        </Button>
      </span>
      <SessionMetadataOverlay
        open={open}
        onClose={handleClose}
        anchorRef={triggerRef}
        contextDisplay={contextDisplay}
        branchLabel={branchLabel}
        usageGroups={usageGroups}
        usageDisplayMode={quotaDisplayMode}
        isUsageLoading={isQuotaLoading}
        timeFormatPreference={timeFormatPreference}
      />
    </>
  );
}
