import React from 'react';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const GITHUB_URL = 'https://github.com/yee94/openchamber';
const DISCORD_URL = 'https://discord.gg/ZYRSdnwwKA';
const X_URL = 'https://x.com/openchamber_dev';

const MIN_CHECKING_DURATION = 800; // ms

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const { t } = useI18n();
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(initialUpdateDialogOpen);
  const [showChecking, setShowChecking] = React.useState(false);
  const [openChamberVersion, setOpenChamberVersion] = React.useState<string | null>(null);
  const [openCodeVersion, setOpenCodeVersion] = React.useState<string | null>(null);
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
  const { isMobile } = useDeviceInfo();

  const currentVersion = openChamberVersion || updateStore.info?.currentVersion || 'unknown';

  React.useEffect(() => {
    let cancelled = false;

    const loadOpenChamberVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { openchamberVersion?: unknown } | null;
        const version = typeof data?.openchamberVersion === 'string' && data.openchamberVersion.trim().length > 0
          ? data.openchamberVersion.trim()
          : null;
        if (!cancelled) setOpenChamberVersion(version);
      } catch {
        if (!cancelled) setOpenChamberVersion(null);
      }
    };

    void loadOpenChamberVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const loadOpenCodeVersion = async () => {
      try {
        const response = await runtimeFetch('/api/opencode/upgrade-status', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { currentVersion?: unknown } | null;
        const version = typeof data?.currentVersion === 'string' && data.currentVersion.trim().length > 0
          ? data.currentVersion.trim()
          : null;
        if (!cancelled) setOpenCodeVersion(version);
      } catch {
        if (!cancelled) setOpenCodeVersion(null);
      }
    };

    void loadOpenCodeVersion();

    return () => {
      cancelled = true;
    };
  }, []);

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
        // Show toast if check completed with no update available
        if (didInitiateCheck.current && !updateStore.available && !updateStore.error) {
          toast.success(t('settings.openchamber.about.toast.latestVersion'));
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [t, updateStore.checking, showChecking, updateStore.available, updateStore.error]);

  const isChecking = updateStore.checking || showChecking;

  if (isMobile) {
    return (
      <div className="w-full space-y-6 pb-2">
        <div className="flex flex-col items-center text-center">
          <OpenChamberLogo width={72} height={72} />
          <h2 className="mt-4 typography-ui-header font-semibold text-foreground">OpenChamber</h2>
        </div>

        <SettingsGroup>
          <SettingsRow label={t('settings.openchamber.about.field.version')}>
            <span className="typography-ui-label font-mono text-foreground text-right">{currentVersion}</span>
          </SettingsRow>
          <SettingsRow label={t('settings.openchamber.about.field.openCodeVersion')}>
            <span className="typography-ui-label font-mono text-foreground text-right">
              {openCodeVersion || t('settings.openchamber.about.state.unknown')}
            </span>
          </SettingsRow>
          <SettingsRow>
            {!updateStore.available && !updateStore.error && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateStore.checkForUpdates()}
                disabled={isChecking}
              >
                {isChecking ? <Icon name="loader" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
                {isChecking ? t('settings.openchamber.about.state.checking') : t('settings.openchamber.about.actions.checkForUpdates')}
              </Button>
            )}

            {!isChecking && updateStore.available && (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => setUpdateDialogOpen(true)}
              >
                <Icon name="download" className="size-4" />
                {t('settings.openchamber.about.actions.updateToVersion', { version: updateStore.info?.version || '' })}
              </Button>
            )}
          </SettingsRow>

          {updateStore.error && (
            <SettingsRow>
              <p className="typography-meta text-[var(--status-error)]">{updateStore.error}</p>
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

            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="discord-fill" className="size-5" />
              <span>Discord</span>
            </a>
          </div>

          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="twitter-xfill" className="size-5" />
            <span>@openchamber_dev</span>
          </a>
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
      </div>
    );
  }

  // Desktop uses the same grouped Settings grammar as other detail pages.
  return (
    <>
      <SettingsGroup label={t('settings.openchamber.about.title')}>
        <SettingsRow label={t('settings.openchamber.about.field.version')}>
          <span className="typography-ui-label font-mono text-foreground text-right">{currentVersion}</span>
        </SettingsRow>
        <SettingsRow label={t('settings.openchamber.about.field.openCodeVersion')}>
          <span className="typography-ui-label font-mono text-foreground text-right">
            {openCodeVersion || t('settings.openchamber.about.state.unknown')}
          </span>
        </SettingsRow>
        <SettingsRow>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {updateStore.checking && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon name="loader" className="h-4 w-4 animate-spin" />
                <span className="typography-meta">{t('settings.openchamber.about.state.checking')}</span>
              </div>
            )}

            {!updateStore.checking && updateStore.available && (
              <Button size="sm"
                variant="default"
                onClick={() => setUpdateDialogOpen(true)}
              >
                <Icon name="download" className="h-4 w-4 mr-1" />
                {t('settings.openchamber.about.actions.updateToVersion', { version: updateStore.info?.version || '' })}
              </Button>
            )}

            {!updateStore.checking && !updateStore.available && !updateStore.error && (
              <span className="typography-meta text-muted-foreground">{t('settings.openchamber.about.state.upToDate')}</span>
            )}

            <Button size="sm"
              variant="outline"
              onClick={() => updateStore.checkForUpdates()}
              disabled={updateStore.checking}
            >
              {t('settings.openchamber.about.actions.checkForUpdates')}
            </Button>
          </div>
        </SettingsRow>

        {updateStore.error && (
          <SettingsRow>
            <p className="typography-meta text-[var(--status-error)]">{updateStore.error}</p>
          </SettingsRow>
        )}

        <SettingsRow controlClassName="flex-wrap">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="github-fill" className="h-4 w-4" />
            <span>GitHub</span>
          </a>

            <a
              href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="twitter-xfill" className="h-4 w-4" />
              <span>@openchamber_dev</span>
            </a>
        </SettingsRow>
      </SettingsGroup>

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
    </>
  );
};
