import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsPageScaffold,
  SettingsPrimaryButton,
  useSettingsTheme,
} from '@/components/settings/SettingsChrome';
import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import { connectionDisplayUrl, getConnectionLabel } from '@/lib/connectionCandidates';
import { t } from '@/lib/i18n';

export function InstancesSettingsPage({ onBack }: { onBack: () => void }) {
  const { state, statusLabel, controller } = useConnection();
  const theme = useSettingsTheme();
  const router = useRouter();

  return (
    <SettingsPageScaffold title={t('settings.pages.instances')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {statusLabel ? (
          <RNView style={{ paddingHorizontal: 20, marginBottom: 8 }}>
            <Text style={{ color: theme.muted }} testID="connection-status">
              {statusLabel}
            </Text>
          </RNView>
        ) : null}
        <SettingsCard>
          {state.connections.map((conn) => {
            const active = state.active?.connectionId === conn.id;
            return (
              <Pressable
                key={conn.id}
                onPress={() => void controller.connectSaved(conn.id)}
                style={{
                  padding: 14,
                  borderBottomWidth: 0.5,
                  borderBottomColor: theme.border,
                  backgroundColor: active ? 'rgba(99,102,241,0.12)' : 'transparent',
                }}
              >
                <Text style={{ color: theme.text, fontWeight: '700' }}>
                  {conn.label || getConnectionLabel(connectionDisplayUrl(conn.candidates))}
                </Text>
                <Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>
                  {connectionDisplayUrl(conn.candidates)}
                </Text>
                <Pressable
                  onPress={() => void controller.removeConnection(conn.id)}
                  style={{ marginTop: 8 }}
                >
                  <Text style={{ color: theme.danger }}>{t('mobile.connect.delete')}</Text>
                </Pressable>
              </Pressable>
            );
          })}
          {state.connections.length === 0 ? (
            <RNView style={{ padding: 16 }}>
              <Text style={{ color: theme.muted, textAlign: 'center' }}>
                {t('mobile.connect.saved.empty')}
              </Text>
            </RNView>
          ) : null}
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('mobile.connect.scanQr')}
          onPress={() => router.push('/qr-scan')}
        />
        <SettingsPrimaryButton
          label={t('mobile.projects.menu.switchInstance')}
          onPress={() => router.push('/connect')}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}
