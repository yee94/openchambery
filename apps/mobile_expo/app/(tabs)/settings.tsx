import { StyleSheet } from 'react-native';

import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { Text, View } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';

export default function SettingsTab() {
  const { state, statusLabel, controller } = useConnection();

  return (
    <View style={styles.container}>
      <PlaceholderScreen
        title="Settings"
        body="Settings home + MOBILE_SETTINGS_PAGE_SLUGS (minus Voice) land in a later slice. No iosNativeUi toggle."
      />
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
});
