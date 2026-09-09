import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConnection } from '@/context/ConnectionContext';
import { parseConnectionPayload } from '@/lib/connectionPayload';
import { pickScannedQrRaw } from '@/lib/qrScan';
import { t } from '@/lib/i18n';

export default function QrScanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { controller } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handling = useRef(false);

  const onBarcode = useCallback(
    async (scan: BarcodeScanningResult) => {
      if (handling.current) return;
      handling.current = true;
      const raw = pickScannedQrRaw(scan as BarcodeScanningResult & {
        raw?: string;
        rawValue?: string;
        displayValue?: string;
      });
      // Never log secret/p= payload — length + scheme only (Cap console style).
      console.info(
        '[mobile-connect]',
        'scan:raw',
        JSON.stringify({
          length: raw.length,
          openchamber: /^openchamber:\/\//i.test(raw),
          http: /^https?:\/\//i.test(raw),
        }),
      );
      if (!raw) {
        setError(t('mobile.connect.scan.invalid'));
        handling.current = false;
        return;
      }

      // Cap scanConnectionQr → resultFromRawValue → redeemPairingConnection / connectWithUrl.
      const parsed = parseConnectionPayload(raw);
      if (!parsed) {
        console.info('[mobile-connect]', 'scan:invalid', JSON.stringify({ length: raw.length }));
        setError(
          /^openchamber:\/\//i.test(raw) && raw.length < 64
            ? `${t('mobile.connect.scan.invalid')} (truncated? len=${raw.length})`
            : t('mobile.connect.scan.invalid'),
        );
        handling.current = false;
        return;
      }

      let ok = false;
      if ('pairing' in parsed) {
        ok = await controller.redeemPairingPayload(parsed.pairing);
      } else {
        ok = await controller.connectWithUrl({
          url: parsed.url,
          clientToken: parsed.clientToken,
          label: parsed.label,
        });
      }
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
        onBarcodeScanned={(result) => {
          void onBarcode(result);
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
