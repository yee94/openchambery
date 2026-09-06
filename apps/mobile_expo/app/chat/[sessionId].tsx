import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

/**
 * Pushed Chat route. The dock stays underneath and must hide once chrome lands.
 * Transcript uses LegendList (not 1.18 TanStack). This file is a stub.
 */
export default function ChatScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chat</Text>
      <Text style={styles.body}>
        Stub pushed session {sessionId ?? 'unknown'}. LegendList, native composer, and Send/Stop
        are not implemented in this bootstrap.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    opacity: 0.75,
  },
});
