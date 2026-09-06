import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsChevron,
  SettingsPageScaffold,
  SettingsPrimaryButton,
  settingsRowDivider,
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
      <ScrollView contentContainerStyle={{ paddingVertical: 16, paddingBottom: 40 }}>
        {statusLabel ? (
          <RNView style={{ paddingHorizontal: 20, marginBottom: 8 }}>
            <Text style={{ color: theme.muted }} testID="connection-status">
              {statusLabel}
            </Text>
          </RNView>
        ) : null}
        <SettingsCard>
          {state.connections.map((conn, index) => {
            const active = state.active?.connectionId === conn.id;
            const isLast = index === state.connections.length - 1;
            return (
              <Pressable
                key={conn.id}
                onPress={() => void controller.connectSaved(conn.id)}
                style={[
                  {
                    paddingHorizontal: 14,
                    paddingVertical: 11,
                    minHeight: 52,
                    backgroundColor: active ? theme.selectionWash : 'transparent',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  },
                  settingsRowDivider(theme.border, isLast),
                ]}
              >
                <RNView style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: theme.text, fontWeight: '600', fontSize: 15 }}>
                    {conn.label || getConnectionLabel(connectionDisplayUrl(conn.candidates))}
                  </Text>
                  <Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>
                    {connectionDisplayUrl(conn.candidates)}
                  </Text>
                  <Pressable
                    onPress={() => void controller.removeConnection(conn.id)}
                    style={{ marginTop: 8 }}
                    hitSlop={8}
                  >
                    <Text style={{ color: theme.danger, fontSize: 13 }}>
                      {t('mobile.connect.delete')}
                    </Text>
                  </Pressable>
                </RNView>
                <SettingsChevron color={theme.muted} />
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
