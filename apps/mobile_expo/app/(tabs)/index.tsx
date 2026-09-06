import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { useColorScheme } from '@/components/useColorScheme';
import { Text } from '@/components/Themed';
import Colors from '@/constants/Colors';

export default function ProjectsScreen() {
  const colorScheme = useColorScheme();
  const router = useRouter();

  return (
    <PlaceholderScreen
      title="Projects"
      body="Stub home. Live session index, pin/in-progress, and 项目 · 分支 land in a later slice. Chat is pushed — not a dock tab."
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open stub chat"
        onPress={() => {
          router.push('/chat/stub');
        }}
        style={[styles.button, { borderColor: Colors[colorScheme].tint }]}
      >
        <Text style={[styles.buttonLabel, { color: Colors[colorScheme].tint }]}>Open stub chat</Text>
      </Pressable>
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
