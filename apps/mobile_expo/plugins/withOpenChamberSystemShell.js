/**
 * Expo config plugin — Track 8 system shell entitlements / Android share receiver.
 * Does NOT invent Capgo, iosNativeUi toggle, or fake glass.
 */
const {
  withInfoPlist,
  withEntitlementsPlist,
  withAndroidManifest,
  createRunOncePlugin,
} = require('expo/config-plugins');

const APP_GROUP = 'group.com.yee94.openchamber';
const PACKAGE_NAME = 'com.yee94.openchamber';

function withIosShell(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSupportsLiveActivities = true;
    cfg.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    const existing = cfg.modResults.CFBundleURLTypes ?? [];
    const hasScheme = existing.some((entry) =>
      (entry.CFBundleURLSchemes ?? []).includes('openchamber'),
    );
    if (!hasScheme) {
      existing.push({
        CFBundleURLName: PACKAGE_NAME,
        CFBundleURLSchemes: ['openchamber'],
      });
      cfg.modResults.CFBundleURLTypes = existing;
    }
    return cfg;
  });

  config = withEntitlementsPlist(config, (cfg) => {
    const groups = new Set(cfg.modResults['com.apple.security.application-groups'] ?? []);
    groups.add(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = Array.from(groups);
    if (!cfg.modResults['aps-environment']) {
      cfg.modResults['aps-environment'] = 'development';
    }
    return cfg;
  });

  return config;
}

function withAndroidShare(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return cfg;

    app.activity = app.activity ?? [];
    const main = app.activity.find(
      (a) =>
        a.$?.['android:name'] === '.MainActivity' ||
        a.$?.['android:name']?.endsWith('MainActivity'),
    );
    if (main) {
      main['intent-filter'] = main['intent-filter'] ?? [];
      const hasSend = main['intent-filter'].some((filter) =>
        (filter.action ?? []).some((a) => a.$?.['android:name'] === 'android.intent.action.SEND'),
      );
      if (!hasSend) {
        main['intent-filter'].push({
          action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [
            { $: { 'android:mimeType': 'text/plain' } },
            { $: { 'android:mimeType': 'image/*' } },
            { $: { 'android:mimeType': '*/*' } },
          ],
        });
        main['intent-filter'].push({
          action: [{ $: { 'android:name': 'android.intent.action.SEND_MULTIPLE' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [
            { $: { 'android:mimeType': 'image/*' } },
            { $: { 'android:mimeType': '*/*' } },
          ],
        });
      }
    }

    const perms = new Set((manifest['uses-permission'] ?? []).map((p) => p.$?.['android:name']));
    for (const name of [
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
    ]) {
      if (!perms.has(name)) {
        manifest['uses-permission'] = manifest['uses-permission'] ?? [];
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    return cfg;
  });
}

const withOpenChamberSystemShell = (config) => {
  config = withIosShell(config);
  config = withAndroidShare(config);
  return config;
};

module.exports = createRunOncePlugin(
  withOpenChamberSystemShell,
  'withOpenChamberSystemShell',
  '1.19.7-beta.7',
);
