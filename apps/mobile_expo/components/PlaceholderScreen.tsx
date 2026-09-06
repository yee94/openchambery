import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

type PlaceholderScreenProps = {
  title: string;
  body: string;
  children?: ReactNode;
};

/** Temporary root-tab body. Not visual parity (关2) and not API parity (关1). */
export function PlaceholderScreen({ title, body, children }: PlaceholderScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {children}
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
