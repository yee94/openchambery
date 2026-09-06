import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import {
  SettingsCard,
  SettingsErrorState,
  SettingsLoading,
  SettingsPageScaffold,
  SettingsRow,
} from '@/components/settings/SettingsChrome';
import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import { loadAboutInfo, type AboutInfo } from '@/lib/settings/aboutApi';
import { t } from '@/lib/i18n';

export function AboutSettingsPage({ onBack }: { onBack: () => void }) {
  const { state } = useConnection();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!state.active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    setError(null);
    try {
      setInfo(await loadAboutInfo(state.active));
    } catch (err) {
      setInfo(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [state.active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.about')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : info == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            <SettingsRow label={t('settings.about.client')}>
              <Text>{info.clientName}</Text>
            </SettingsRow>
            <SettingsRow label={t('settings.about.clientVersion')}>
              <Text>{info.clientVersion}</Text>
            </SettingsRow>
            <SettingsRow label={t('settings.about.serverOpenChamber')}>
              <Text>{info.serverOpenChamber ?? '—'}</Text>
            </SettingsRow>
            <SettingsRow label={t('settings.about.serverOpenCode')}>
              <Text>{info.serverOpenCode ?? '—'}</Text>
            </SettingsRow>
            <SettingsRow label={t('settings.about.serverId')}>
              <Text>{info.serverId ?? '—'}</Text>
            </SettingsRow>
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}
