import type { CapacitorConfig } from '@capacitor/cli';

// OTA channel / shellApiVersion literals must stay in sync with
// src/openchamber-ota.ts (OPENCHAMBER_OTA_CHANNEL, OPENCHAMBER_SHELL_API_VERSION).
// Do not import that module here — Cap CLI loads this file and would execute registerPlugin.
// OTA channel baked into the shell at build time. Beta builds (TestFlight /
// sideloaded APK) keep the default; stable store builds pass
// OPENCHAMBER_OTA_CHANNEL=stable during `mobile:sync`. Keep in sync with
// packages/mobile/src/openchamber-ota.ts defaults.
const otaChannel = process.env.OPENCHAMBER_OTA_CHANNEL === 'stable' ? 'stable' : 'beta';
const config: CapacitorConfig & {
  OpenChamberOTA: {
    channel: string;
    shellApiVersion: number;
  };
} = {
  appId: 'com.yee94.openchamber',
  appName: 'OpenChamber',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // The Android WebView serves the app from an https:// origin, so its fetch
    // and WebSocket calls to plain-http LAN servers (http://192.168.x.x) are
    // blocked as mixed content even with cleartext allowed in the manifest.
    // Allow it — LAN transport is a core feature; iOS has no equivalent issue
    // (capacitor:// scheme) and relay/tunnel traffic is TLS anyway.
    allowMixedContent: true,
  },
  // Web layer reads this at runtime for channel + native bridge contract gating.
  // shellApiVersion is the native bridge contract version — bump when any custom
  // Capacitor plugin method surface changes; OTA manifests declare minShellApiVersion
  // and older shells get `install_native_required` instead of a broken bundle.
  OpenChamberOTA: {
    channel: otaChannel,
    shellApiVersion: 1,
  },
  plugins: {
    Keyboard: {
      // iOS: resize none + JS composer transform FLIP. Android: adjustNothing +
      // pre-focus cached-height composer CSS FLIP; ImeSyncBridge keeps parent
      // padding zero and reports state/settled height. resizeOnFullScreen stays off.
      resize: 'none',
      resizeOnFullScreen: false,
      autoBackdropColor: 'dom',
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DEFAULT',
    },
    PushNotifications: {
      // Never display an APNs alert while the app is foreground. The server always sends
      // (no racy visibility gate); iOS suppresses the foreground banner, so there is no
      // notification when the app is active. Background pushes are shown by iOS as usual.
      presentationOptions: [],
    },
    // Self-hosted Capgo OTA (@capgo/capacitor-updater). Native pods/gradle wiring
    // lands via `bun run mobile:sync` in CI — not checked in from this config alone.
    CapacitorUpdater: {
      // Override for local/dev self-hosted check endpoints; production default points at
      // the public update-service OTA check route.
      updateUrl: process.env.OPENCHAMBER_OTA_UPDATE_URL ?? 'https://openchamber.xiaobe.top/v1/ota/check',
      // Empty string disables Capgo cloud stats reporting (self-hosted only).
      statsUrl: '',
      defaultChannel: otaChannel,
      // Check+download in foreground; apply on next background (Capgo autoUpdate: true).
      autoUpdate: true,
      // Raised above Capgo's 10s default: mobile splash + remote-config-free cold start
      // can exceed 10s on low-end devices before JS can call notifyAppReady.
      appReadyTimeout: 20000,
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      resetWhenUpdate: true,
      // Optional E2E encryption public key; empty string = unencrypted bundles.
      publicKey: process.env.OPENCHAMBER_OTA_PUBLIC_KEY ?? '',
    },
  },
};

export default config;
