import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  fetchStoredPasskeys,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  registerCurrentDevicePasskey,
  resetAllAuth,
  revokeStoredPasskey,
  type PasskeyStatus,
  type StoredPasskey,
} from '@/lib/passkeys';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const formatTimestamp = (timestamp: number | null, neverUsedText: string, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return neverUsedText;
  }

  return new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: timeFormatPreference === 'auto' ? undefined : timeFormatPreference === '12h',
  }).format(timestamp);
};

export const PasskeySettings: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRegistering, setIsRegistering] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [isResetting, setIsResetting] = React.useState(false);
  const [passkeys, setPasskeys] = React.useState<StoredPasskey[]>([]);
  const [status, setStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [errorMessage, setErrorMessage] = React.useState('');
  const supportState = React.useMemo(() => getPasskeySupportState(), []);

  const loadPasskeys = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const nextPasskeys = await fetchStoredPasskeys();
      setPasskeys(nextPasskeys);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.yuri.passkeys.toast.loadFailed');
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!supportState.supported) {
          if (!cancelled) {
            setSupportsPasskeys(false);
            setIsLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }

      if (!cancelled) {
        const nextStatus = await fetchPasskeyStatus();
        setStatus(nextStatus);
        if (!nextStatus.enabled) {
          setPasskeys([]);
          setIsLoading(false);
          return;
        }
        await loadPasskeys();
      }
    })();

    return () => {
      cancelled = true;
      cancelPasskeyCeremony();
    };
  }, [loadPasskeys, supportState.supported]);

  const handleRegisterPasskey = React.useCallback(async () => {
    if (!status.enabled) {
      const message = t('settings.yuri.passkeys.toast.enableUiPasswordFirst');
      setErrorMessage(message);
      toast.message(message);
      return;
    }

    if (!supportsPasskeys) {
      setErrorMessage(supportState.reason);
      toast.message(supportState.reason);
      return;
    }

    if (isRegistering) {
      cancelPasskeyCeremony();
      setIsRegistering(false);
      return;
    }

    setErrorMessage('');
    setIsRegistering(true);

    try {
      await registerCurrentDevicePasskey();
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('settings.yuri.passkeys.toast.added'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('settings.yuri.passkeys.toast.setupCanceled'));
        return;
      }

      const message = error instanceof Error ? error.message : t('settings.yuri.passkeys.toast.addFailed');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setIsRegistering(false);
    }
  }, [isRegistering, loadPasskeys, status.enabled, supportState.reason, supportsPasskeys, t]);

  const handleRevokePasskey = React.useCallback(async (id: string) => {
    setRevokingId(id);
    setErrorMessage('');

    try {
      await revokeStoredPasskey(id);
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('settings.yuri.passkeys.toast.removed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.yuri.passkeys.toast.removeFailed');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  }, [loadPasskeys, t]);

  const handleResetAllAuth = React.useCallback(async () => {
    setIsResetting(true);
    setErrorMessage('');

    try {
      await resetAllAuth();
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.yuri.passkeys.toast.clearAuthFailed');
      setErrorMessage(message);
      toast.error(message);
      setIsResetting(false);
    }
  }, [t]);

  return (
    <SettingsGroup label={t('settings.yuri.passkeys.title')}>
        <SettingsRow label={t('settings.yuri.passkeys.field.currentDevice')}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant={isRegistering ? 'secondary' : 'outline'}
              size="xs"
              onClick={() => void handleRegisterPasskey()}
              disabled={isLoading || isResetting}
              className="!font-normal"
            >
              {isRegistering ? t('settings.yuri.passkeys.actions.cancelSetup') : t('settings.yuri.passkeys.actions.add')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleResetAllAuth()}
              disabled={isLoading || isRegistering || isResetting}
              className="!font-normal text-muted-foreground hover:text-foreground"
            >
              {isResetting ? t('settings.yuri.passkeys.actions.signingOut') : t('settings.yuri.passkeys.actions.signOutEverywhere')}
            </Button>
          </div>
        </SettingsRow>

        {!status.enabled && (
          <p className="yuri-settings-group-row typography-meta text-muted-foreground">
            {t('settings.yuri.passkeys.state.uiPasswordRequired')}
          </p>
        )}

        {status.enabled && !supportsPasskeys && (
          <p className="yuri-settings-group-row typography-meta text-muted-foreground">
            {supportState.reason}
          </p>
        )}

        {isLoading ? (
          <p className="yuri-settings-group-row typography-meta text-muted-foreground">{t('settings.yuri.passkeys.state.loading')}</p>
        ) : passkeys.length === 0 ? (
          <p className="yuri-settings-group-row typography-meta text-muted-foreground">{t('settings.yuri.passkeys.state.noneSaved')}</p>
        ) : (
          <>
            {passkeys.map((passkey) => (
              <SettingsRow key={passkey.id} label={passkey.label} copyClassName="truncate">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="typography-meta text-muted-foreground truncate">
                    {passkey.lastUsedAt
                      ? t('settings.yuri.passkeys.item.lastUsed', {
                          time: formatTimestamp(passkey.lastUsedAt, t('settings.yuri.passkeys.time.neverUsed'), timeFormatPreference),
                        })
                      : t('settings.yuri.passkeys.item.added', {
                          time: formatTimestamp(passkey.createdAt, t('settings.yuri.passkeys.time.neverUsed'), timeFormatPreference),
                        })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleRevokePasskey(passkey.id)}
                    disabled={revokingId === passkey.id}
                    className="!font-normal text-muted-foreground hover:text-foreground"
                  >
                    {revokingId === passkey.id ? t('settings.yuri.passkeys.actions.removing') : t('settings.common.actions.delete')}
                  </Button>
                </div>
              </SettingsRow>
            ))}
          </>
        )}

      {errorMessage && (
        <div className="yuri-settings-group-row">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
        </div>
      )}
    </SettingsGroup>
  );
};
