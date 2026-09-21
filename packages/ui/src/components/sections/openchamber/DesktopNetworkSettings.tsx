import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
  usesFramelessElectronChrome,
  type DesktopWindowControlsPosition,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const WINDOW_CONTROLS_POSITION_OPTIONS: Array<{ id: DesktopWindowControlsPosition; labelKey: string }> = [
  { id: 'auto', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsAuto' },
  { id: 'left', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsLeft' },
  { id: 'right', labelKey: 'settings.openchamber.desktopNetwork.option.windowControlsRight' },
];

export const DesktopNetworkSettings: React.FC = () => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const showWindowControlsPosition = usesFramelessElectronChrome();
  const desktopWindowControlsPosition = useUIStore((state) => state.desktopWindowControlsPosition);
  const setDesktopWindowControlsPosition = useUIStore((state) => state.setDesktopWindowControlsPosition);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setLaunchAtLoginSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopLaunchAtLogin();
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(status?.supported === true);
      setLaunchAtLoginEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setMinimizeToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMinimizeToTray();
      if (cancelled) {
        return;
      }
      setMinimizeToTraySupported(status?.supported === true);
      setMinimizeToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopKeepAwake();
      if (cancelled) {
        return;
      }
      setKeepAwakeSupported(status?.supported === true);
      setKeepAwakeEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  const handleWindowControlsPositionChange = React.useCallback((value: DesktopWindowControlsPosition) => {
    setDesktopWindowControlsPosition(value);
    void updateDesktopSettings({ desktopWindowControlsPosition: value });
  }, [setDesktopWindowControlsPosition]);

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.launchAtLoginSaveFailed'));
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported, t]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
      }
      if (!status.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTrayUnsupported'));
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported, t]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.keepAwakeSaveFailed'));
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported, t]);

  if (!isLocalDesktop && !showWindowControlsPosition) {
    return null;
  }

  return (
    <div className="oc-settings-section-stack">
      {showWindowControlsPosition ? (
        <SettingsGroup label={t('settings.openchamber.desktopNetwork.field.windowControlsPosition')}>
          <SettingsRow
            itemId="sessions.desktop-window-controls-position"
            label={t('settings.openchamber.desktopNetwork.field.windowControlsPosition')}
            description={t('settings.openchamber.desktopNetwork.field.windowControlsPositionDescription')}
          >
            <div
              className="flex flex-wrap items-center justify-end gap-1"
              role="group"
              aria-label={t('settings.openchamber.desktopNetwork.field.windowControlsPositionAria')}
            >
              {WINDOW_CONTROLS_POSITION_OPTIONS.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="chip"
                  size="xs"
                  className="!font-normal"
                  aria-pressed={desktopWindowControlsPosition === option.id}
                  onClick={() => handleWindowControlsPositionChange(option.id)}
                >
                  {tUnsafe(option.labelKey)}
                </Button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {!isLocalDesktop || !(launchAtLoginSupported || minimizeToTraySupported || keepAwakeSupported || error) ? null : (
        <SettingsGroup label={t('settings.openchamber.desktopNetwork.title')}>
        {launchAtLoginSupported ? (
          <div
            data-settings-item="sessions.desktop-launch-at-login"
            className="oc-settings-group-row oc-settings-split-row group cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={handleLaunchAtLoginToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleLaunchAtLoginToggle();
              }
            }}
          >
            <div className="oc-settings-split-row-copy">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.launchAtLogin')}</div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.desktopNetwork.field.launchAtLoginDescription')}
              </div>
            </div>
            <div className="oc-settings-split-row-control">
              <Checkbox
                checked={launchAtLoginEnabled}
                onChange={handleLaunchAtLoginToggle}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.launchAtLoginAria')}
                disabled={isSavingLaunchAtLogin}
              />
            </div>
          </div>
        ) : null}

        {minimizeToTraySupported ? (
          <div
            data-settings-item="sessions.desktop-minimize-to-tray"
            className="oc-settings-group-row oc-settings-split-row group cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={handleMinimizeToTrayToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleMinimizeToTrayToggle();
              }
            }}
          >
            <div className="oc-settings-split-row-copy">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.minimizeToTray')}</div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.desktopNetwork.field.minimizeToTrayDescription')}
              </div>
            </div>
            <div className="oc-settings-split-row-control">
              <Checkbox
                checked={minimizeToTrayEnabled}
                onChange={handleMinimizeToTrayToggle}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.minimizeToTrayAria')}
                disabled={isSavingMinimizeToTray}
              />
            </div>
          </div>
        ) : null}

        {keepAwakeSupported ? (
          <div
            data-settings-item="sessions.desktop-keep-awake"
            className="oc-settings-group-row oc-settings-split-row group cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={handleKeepAwakeToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleKeepAwakeToggle();
              }
            }}
          >
            <div className="oc-settings-split-row-copy">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.keepAwake')}</div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.desktopNetwork.field.keepAwakeDescription')}
              </div>
            </div>
            <div className="oc-settings-split-row-control">
              <Checkbox
                checked={keepAwakeEnabled}
                onChange={handleKeepAwakeToggle}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.keepAwakeAria')}
                disabled={isSavingKeepAwake}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="oc-settings-group-row typography-meta text-[var(--status-error)]">{error}</div>
        ) : null}
        </SettingsGroup>
      )}
    </div>
  );
};
