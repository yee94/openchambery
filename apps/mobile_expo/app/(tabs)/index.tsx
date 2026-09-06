import { Link } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { Text } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

export default function ProjectsScreen() {
  const colorScheme = useColorScheme();

  return (
    <PlaceholderScreen
      title="Projects"
      body="Stub home. Live session index, pin/in-progress, and 项目 · 分支 land in a later slice. Chat is pushed — not a dock tab."
    >
      <Link href={{ pathname: '/chat/[sessionId]', params: { sessionId: 'stub' } }} asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open stub chat"
          style={[styles.button, { borderColor: Colors[colorScheme].tint }]}
        >
          <Text style={[styles.buttonLabel, { color: Colors[colorScheme].tint }]}>Open stub chat</Text>
        </Pressable>
      </Link>
    </PlaceholderScreen>
  );
}

const styles = StyleSheet.create({
  button: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
