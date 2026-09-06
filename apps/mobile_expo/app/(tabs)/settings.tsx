import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';

import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { Text, View } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import { t } from '@/lib/i18n';

/**
 * Settings home lands in Track 7. Track 5 Assistant routes edit/create here via
 * `slug=assistants` (+ optional assistantId / create) so the dock target exists.
 */
export default function SettingsTab() {
  const { state, statusLabel, controller } = useConnection();
  const params = useLocalSearchParams<{
    slug?: string | string[];
    assistantId?: string | string[];
    create?: string | string[];
  }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const assistantId = Array.isArray(params.assistantId)
    ? params.assistantId[0]
    : params.assistantId;
  const create = Array.isArray(params.create) ? params.create[0] : params.create;

  const assistantsHint =
    slug === 'assistants'
      ? create === '1'
        ? t('assistants.settings.createPending')
        : assistantId
          ? t('assistants.settings.editPending', { id: assistantId })
          : t('assistants.settings.slugPending')
      : null;

  return (
    <View style={styles.container}>
      <PlaceholderScreen
        title={t('mobile.tabs.settings')}
        body="Settings home + MOBILE_SETTINGS_PAGE_SLUGS (minus Voice) land in a later slice. No iosNativeUi toggle."
      >
        {assistantsHint ? (
          <Text style={styles.hint} testID="settings-assistants-slug">
            {assistantsHint}
          </Text>
        ) : null}
      </PlaceholderScreen>
      {statusLabel ? (
        <Text style={styles.status} testID="connection-status">
          {statusLabel}
        </Text>
      ) : null}
      {state.active ? (
        <Text
          style={styles.disconnect}
          onPress={() => void controller.removeConnection(state.active!.connectionId)}
        >
          Disconnect active instance
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  status: {
    textAlign: 'center',
    paddingBottom: 8,
    opacity: 0.8,
  },
  disconnect: {
    textAlign: 'center',
    color: '#E07A3D',
    paddingBottom: 24,
  },
  hint: {
    textAlign: 'center',
    opacity: 0.85,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 12,
  },
});
