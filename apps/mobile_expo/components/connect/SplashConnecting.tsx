import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';

export function SplashConnecting({ label }: { label: string | null }) {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#E07A3D" />
      <Text style={styles.title}>{t('mobile.connect.connecting')}</Text>
      {label ? (
        <>
          <Text style={styles.caption}>{t('mobile.connect.splash.connectingTo')}</Text>
          <Text style={styles.label}>{label}</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    marginTop: 16,
    fontWeight: '600',
  },
  caption: {
    color: '#888',
    marginTop: 12,
    fontSize: 13,
  },
  label: {
    color: '#ddd',
    marginTop: 4,
    fontSize: 16,
  },
});
