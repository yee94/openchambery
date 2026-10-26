import React from 'react';
import { useEvent } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useUIStore } from '@/stores/useUIStore';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import { YuriLogo } from '@/components/ui/YuriLogo';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { formatMobileClientVersionLabel, getMobileClientVersion, getMobileClientBuildNumber } from '@/lib/mobileAppVersion';
import { isCapacitorApp } from '@/lib/platform';
import { readNativeUpdateConfig } from '@/lib/mobile-updates/native-config';
import { isElectronShell, getDesktopAppVersion } from '@/lib/desktop';
import {
  exportAndDownloadClientDiagnostics,
  isTranscriptDiagnosticsEnabled,
  setTranscriptDiagnosticsEnabled,
} from '@/sync/transcript-diagnostics-runtime';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';

const GITHUB_URL = 'https://github.com/yee94/yuri';
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new`;

const MIN_CHECKING_DURATION = 800; // ms

const MANAGEMENT_KEYS = {
  'manual-global': 'settings.yuri.about.opencodeManagement.manual-global',
  'manual-external': 'settings.yuri.about.opencodeManagement.manual-external',
  bundled: 'settings.yuri.about.opencodeManagement.bundled',
  'in-app': 'settings.yuri.about.opencodeManagement.in-app',
  none: 'settings.yuri.about.opencodeManagement.none',
} as const satisfies Record<string, I18nKey>;

type AboutSnapshot = {
  yuriVersion?: unknown;
  currentVersion?: unknown;
  serveVersion?: unknown;
  canManage?: unknown;
  management?: unknown;
  guidance?: unknown;
};
const snapshotText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const aboutSnapshotQueryOptions = (path: '/api/system/info' | '/api/opencode/upgrade-status', transport: string, generation: number) => ({
  queryKey: [transport, 'about', generation, path] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<AboutSnapshot> => {
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('Stale About runtime');
    const response = await runtimeFetch(path, { method: 'GET', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`About snapshot: ${response.status}`);
    const snapshot: unknown = await response.json();
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid About snapshot');
    if (signal.aborted || transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('Stale About runtime');
    return snapshot as AboutSnapshot;
  },
  retry: false,
  staleTime: 30_000,
});

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const { t } = useI18n();
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(initialUpdateDialogOpen);
  const [rollbackDialogOpen, setRollbackDialogOpen] = React.useState(false);
  const [showChecking, setShowChecking] = React.useState(false);
  const [clientVersion, setClientVersion] = React.useState<string | null>(null);
  const [clientBuildNumber, setClientBuildNumber] = React.useState<number | null>(null);
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const systemInfo = useQuery(aboutSnapshotQueryOptions('/api/system/info', transport, generation));
  const upgradeStatus = useQuery(aboutSnapshotQueryOptions('/api/opencode/upgrade-status', transport, generation));
  const yuriVersion = snapshotText(systemInfo.data?.yuriVersion);
  const snapshot = upgradeStatus.data;
  const version = snapshotText(snapshot?.serveVersion) ?? snapshotText(snapshot?.currentVersion);
  const management = snapshotText(snapshot?.management);
  const managementKey = management && Object.hasOwn(MANAGEMENT_KEYS, management)
    ? MANAGEMENT_KEYS[management as keyof typeof MANAGEMENT_KEYS]
    : null;
  const managementLabel = snapshot?.canManage === false && managementKey ? t(managementKey) : null;
  const openCodeVersion = version && managementLabel
    ? t('settings.yuri.about.opencodeVersionWithManagement', { version, management: managementLabel })
    : version;
  const managementGuidance = snapshot?.canManage === false
    ? management === 'manual-global'
      ? t('settings.yuri.about.opencodeGuidance.manualGlobal')
      : management === 'manual-external'
        ? t('settings.yuri.about.opencodeGuidance.manualExternal')
        : management === 'bundled'
          ? t('settings.yuri.about.opencodeGuidance.bundled')
          : null
    : null;
  const updateStore = useUpdateStore(useShallow((s) => ({
    info: s.info,
    checking: s.checking,
    available: s.available,
    error: s.error,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    runtimeType: s.runtimeType,
    checkForUpdates: s.checkForUpdates,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));
  const otaChannelOverride = useUIStore((state) => state.otaChannelOverride);
  const setOtaChannelOverride = useUIStore((state) => state.setOtaChannelOverride);
  const isNativeMobileApp = isCapacitorApp();
  const [desktopBakedChannel, setDesktopBakedChannel] = React.useState<'beta' | 'stable'>('stable');
  React.useEffect(() => {
    if (isElectronShell()) void getDesktopAppVersion().then((version) => setDesktopBakedChannel(version?.includes('-') ? 'beta' : 'stable'));
  }, []);
  const nativeUpdateConfig = useQuery({
    queryKey: ['native-update-config'],
    queryFn: readNativeUpdateConfig,
    enabled: isNativeMobileApp,
    staleTime: Infinity,
    retry: false,
  });
  const bakedOtaChannel = nativeUpdateConfig.data?.channel;
  // The switch shows the effective opt-in state while preserving null as
  // “follow the baked channel”: explicit beta, or an untouched beta build.
  const betaUpdatesEnabled = otaChannelOverride === 'beta'
    || (otaChannelOverride === null && (isElectronShell() ? desktopBakedChannel : bakedOtaChannel) === 'beta');
  const [exportingDiagnostics, setExportingDiagnostics] = React.useState(false);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = React.useState(() => isTranscriptDiagnosticsEnabled());

  const handleDiagnosticsEnabledChange = useEvent((enabled: boolean) => {
    setTranscriptDiagnosticsEnabled(enabled);
    setDiagnosticsEnabled(enabled);
  });

  const handleBetaUpdatesChange = useEvent(async (enabled: boolean) => {
    if (enabled) {
      setOtaChannelOverride('beta');
      await useUpdateStore.getState().checkForUpdates();
      return;
    }

    setOtaChannelOverride('stable');
    await useUpdateStore.getState().checkForUpdates();
    const { info, otaDecision } = useUpdateStore.getState();
    if (info?.isChannelRollback === true && otaDecision?.primaryAction === 'apply_ota') {
      setRollbackDialogOpen(true);
    }
  });

  const handleRollbackCancel = useEvent(() => {
    setRollbackDialogOpen(false);
    setOtaChannelOverride('beta');
    void useUpdateStore.getState().checkForUpdates();
  });

  const handleRollbackConfirm = useEvent(() => {
    setRollbackDialogOpen(false);
    setUpdateDialogOpen(true);
    void useUpdateStore.getState().downloadUpdate();
  });

  const handleRollbackDialogOpenChange = useEvent((open: boolean) => {
    if (!open) handleRollbackCancel();
  });

  const currentVersion = clientVersion || t('settings.yuri.about.state.unknown');

  const handleExportDiagnostics = useEvent(async () => {
    if (exportingDiagnostics) return;
    setExportingDiagnostics(true);
    try {
      const { outcome, eventCount } = await exportAndDownloadClientDiagnostics();
      if (outcome === 'cancelled') return;
      if (outcome === 'failed') {
        toast.error(t('settings.yuri.about.diagnostics.toast.failed'));
        return;
      }
      toast.success(
        eventCount > 0
          ? t('settings.yuri.about.diagnostics.toast.exported')
          : t('settings.yuri.about.diagnostics.toast.empty'),
      );
    } catch {
      toast.error(t('settings.yuri.about.diagnostics.toast.failed'));
    } finally {
      setExportingDiagnostics(false);
    }
  });

  React.useEffect(() => {
    let cancelled = false;

    void getMobileClientVersion().then((version) => {
      if (!cancelled) setClientVersion(version);
    });
    void getMobileClientBuildNumber().then((build) => {
      if (!cancelled) setClientBuildNumber(build);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // iOS marketing versions strip `-beta.N`, so append the native build number
  // (the only stable per-shell identity there), e.g. 1.18.2 (370).
  const currentVersionLabel = formatMobileClientVersionLabel(clientVersion, clientBuildNumber)
    ?? currentVersion;

  // Track if we initiated a check to show toast on completion
  const didInitiateCheck = React.useRef(false);

  // Ensure minimum visible duration for checking animation
  React.useEffect(() => {
    if (updateStore.checking) {
      setShowChecking(true);
      didInitiateCheck.current = true;
    } else if (showChecking) {
      const timer = setTimeout(() => {
        setShowChecking(false);
        // Surface check failures separately from a confirmed up-to-date result.
        if (didInitiateCheck.current && updateStore.error) {
          toast.error(t('settings.yuri.about.toast.checkFailed'), {
            description: updateStore.error,
          });
          didInitiateCheck.current = false;
        } else if (didInitiateCheck.current && !updateStore.available && !updateStore.error) {
          toast.success(t('settings.yuri.about.toast.latestVersion'));
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [t, updateStore.checking, showChecking, updateStore.available, updateStore.error]);

  const isChecking = updateStore.checking || showChecking;

  return (
      <div className="yuri-settings-section-stack w-full">
        <div className="flex flex-col items-center text-center">
          <YuriLogo width={72} height={72} />
          <h2 className="mt-4 typography-ui-header font-semibold text-foreground">Yuri</h2>
        </div>

        <SettingsGroup className="yuri-settings-about">
          <SettingsRow label={t('settings.yuri.about.field.clientVersion')}>
            <span className="typography-ui-label font-mono text-foreground text-right">{currentVersionLabel}</span>
          </SettingsRow>
          <SettingsRow label={t('settings.yuri.about.field.instanceYuriVersion')}>
            <span className="typography-ui-label font-mono text-foreground text-right">
              {yuriVersion || t('settings.yuri.about.state.unknown')}
            </span>
          </SettingsRow>
          <SettingsRow label={t('settings.yuri.about.field.instanceOpenCodeVersion')} description={managementGuidance}>
            <span className="typography-ui-label font-mono text-foreground text-right">
              {openCodeVersion || t('settings.yuri.about.state.unknown')}
            </span>
          </SettingsRow>
          <SettingsRow className="yuri-settings-split-row-stacked" copyClassName="hidden">
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              <Button asChild variant="outline" size="sm" className="whitespace-nowrap" data-settings-item="about.feedback">
                <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                  <Icon name="question" className="size-4" />
                  {t('settings.yuri.about.actions.submitFeedback')}
                </a>
              </Button>
              {!isChecking && updateStore.available ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="whitespace-nowrap"
                onClick={() => setUpdateDialogOpen(true)}
                data-settings-item="about.check-updates"
              >
                <Icon name="download" className="size-4" />
                {updateStore.info?.inAppApply
                  ? t('settings.yuri.about.actions.applyOtaToVersion', { version: updateStore.info?.version || '' })
                  : updateStore.info?.manualUpdate
                    ? t('settings.yuri.about.actions.installNativeToVersion', { version: updateStore.info?.version || '' })
                    : t('settings.yuri.about.actions.updateToVersion', { version: updateStore.info?.version || '' })}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="whitespace-nowrap"
                onClick={() => updateStore.checkForUpdates()}
                data-settings-item="about.check-updates"
                disabled={isChecking}
              >
                {isChecking ? <Icon name="loader" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
                {isChecking ? t('settings.yuri.about.state.checking') : t('settings.yuri.about.actions.checkForUpdates')}
              </Button>
            )}
            </div>
          </SettingsRow>

          {updateStore.error && (
            <SettingsRow>
              <p className="typography-meta text-[var(--status-error)]">{updateStore.error}</p>
            </SettingsRow>
          )}
          {(isNativeMobileApp || isElectronShell()) && (
            <SettingsToggleRow
              itemId="about.beta-updates"
              checked={betaUpdatesEnabled}
              onChange={handleBetaUpdatesChange}
              label={t('settings.yuri.about.betaUpdates.label')}
              description={t('settings.yuri.about.betaUpdates.description')}
              ariaLabel={t('settings.yuri.about.betaUpdates.label')}
              disabled={isChecking || (isNativeMobileApp && !nativeUpdateConfig.data)}
            />
          )}
          <SettingsToggleRow
            itemId="about.diagnostics"
            checked={diagnosticsEnabled}
            onChange={handleDiagnosticsEnabledChange}
            label={t('settings.yuri.about.diagnostics.label')}
            ariaLabel={t('settings.yuri.about.diagnostics.label')}
          />
          {diagnosticsEnabled && (
          <SettingsRow
            itemId="about.export-diagnostics"
            label={t('settings.yuri.about.diagnostics.export')}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exportingDiagnostics}
              onClick={() => void handleExportDiagnostics()}
            >
              {exportingDiagnostics
                ? t('settings.yuri.about.diagnostics.exporting')
                : t('settings.yuri.about.diagnostics.export')}
            </Button>
          </SettingsRow>
          )}
        </SettingsGroup>

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center gap-5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="github-fill" className="size-5" />
              <span>GitHub</span>
            </a>
          </div>
        </div>

        <p className="text-center typography-ui text-muted-foreground/60">
          {t('aboutDialog.footerNote')}
        </p>

        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={updateStore.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          progress={updateStore.progress}
          error={updateStore.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={updateStore.runtimeType}
        />

        <Dialog open={rollbackDialogOpen} onOpenChange={handleRollbackDialogOpenChange}>
          <DialogContent showCloseButton={false} className="max-w-sm gap-5">
            <DialogHeader>
              <DialogTitle>{t('settings.yuri.about.betaUpdates.rollback.title')}</DialogTitle>
              <DialogDescription>
                {t('settings.yuri.about.betaUpdates.rollback.description', {
                  version: updateStore.info?.version || '',
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" size="sm" variant="ghost" onClick={handleRollbackCancel}>
                {t('settings.yuri.about.betaUpdates.rollback.actions.cancel')}
              </Button>
              <Button type="button" size="sm" onClick={handleRollbackConfirm}>
                {t('settings.yuri.about.betaUpdates.rollback.actions.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
  );
};
