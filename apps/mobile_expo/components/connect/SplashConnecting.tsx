import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { t } from '@/lib/i18n';

export function SplashConnecting({ label }: { label: string | null }) {
  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.tint} />
      <Text style={[styles.title, { color: text }]}>{t('mobile.connect.connecting')}</Text>
      {label ? (
        <>
          <Text style={[styles.caption, { color: muted }]}>
            {t('mobile.connect.splash.connectingTo')}
          </Text>
          <Text style={[styles.label, { color: text }]}>{label}</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 18,
    marginTop: 16,
    fontWeight: '600',
  },
  caption: {
    marginTop: 12,
    fontSize: 13,
  },
  label: {
    marginTop: 4,
    fontSize: 16,
  },
});
