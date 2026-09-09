/**
 * Ensure Android cleartext HTTP stays allowed after prebuild (LAN http://192.168.x).
 *
 * Cap ships android:usesCleartextTraffic="true" on the application element. Expo
 * app.json `android.usesCleartextTraffic` usually maps the same attribute, but
 * future template/plugin churn can drop it and silently force every LAN probe
 * onto relay (or fail entirely on VPN-split devices). This plugin re-asserts
 * the attribute idempotently.
 */
const { withAndroidManifest, createRunOncePlugin } = require('expo/config-plugins');

function ensureCleartext(androidManifest) {
  const manifest = androidManifest.manifest;
  if (!manifest) return androidManifest;
  const app = manifest.application?.[0];
  if (!app) return androidManifest;
  app.$ = app.$ || {};
  app.$['android:usesCleartextTraffic'] = 'true';
  return androidManifest;
}

const withAndroidCleartextTraffic = (config) => {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = ensureCleartext(cfg.modResults);
    return cfg;
  });
};

module.exports = createRunOncePlugin(
  withAndroidCleartextTraffic,
  'withAndroidCleartextTraffic',
  '1.0.0',
);
module.exports.ensureCleartext = ensureCleartext;
