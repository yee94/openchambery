import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConnection } from '@/context/ConnectionContext';
import { t } from '@/lib/i18n';

export default function QrScanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { controller } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handling = useRef(false);

  const onBarcode = useCallback(
    async (raw: string) => {
      if (handling.current) return;
      handling.current = true;
      const ok = await controller.redeemPairingLink(raw);
      if (ok) {
        router.replace('/');
        return;
      }
      setError(controller.getState().error ?? t('mobile.connect.scan.invalid'));
      handling.current = false;
    },
    [controller, router],
  );

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.message}>{t('mobile.connect.scan.permissionDenied')}</Text>
        <Pressable style={styles.button} onPress={() => void requestPermission()}>
          <Text style={styles.buttonText}>{t('mobile.connect.scanQr')}</Text>
        </Pressable>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (data) void onBarcode(data);
        }}
      />
      <View style={[styles.overlay, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancel}>×</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    padding: 20,
  },
  message: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#E07A3D',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  cancel: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  error: {
    color: '#ff6b6b',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 12,
    borderRadius: 10,
    overflow: 'hidden',
  },
});
