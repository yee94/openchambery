// Builds the iOS app for a connected physical device (Personal Team / side-load).
//
// The release/TestFlight project uses team 5J7WJGPA2Q with Push + App Group
// `group.com.openchamber.app`. A free Personal Team cannot use Push, and that App Group
// belongs to another team. This script temporarily strips Push and rewrites the App Group
// to a Personal-Team-local identifier, builds a signed .app, then restores entitlements so
// release/device/TestFlight builds keep the production capabilities.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const iosAppDir = join(mobileRoot, 'ios', 'App');

const developmentTeam = process.env.DEVELOPMENT_TEAM || process.env.IOS_DEVELOPMENT_TEAM || '6W97S9B7CZ';
const devAppGroup = process.env.IOS_DEV_APP_GROUP || 'group.com.yeewang.openchamber.dev';
const productionAppGroup = 'group.com.openchamber.app';
const devBundlePrefix = process.env.IOS_DEV_BUNDLE_ID || 'com.yeewang.openchamber.dev';
const pbxprojPath = join(iosAppDir, 'App.xcodeproj', 'project.pbxproj');

const bundleIdReplacements = [
  ['com.openchamber.app.OpenChamberShareExtension', `${devBundlePrefix}.OpenChamberShareExtension`],
  ['com.openchamber.app.OpenChamberNotificationService', `${devBundlePrefix}.OpenChamberNotificationService`],
  ['com.openchamber.app.OpenChamberWidget', `${devBundlePrefix}.OpenChamberWidget`],
  ['com.openchamber.app', devBundlePrefix],
];

const entitlementPaths = [
  join(iosAppDir, 'App', 'App.entitlements'),
  join(iosAppDir, 'OpenChamberWidget', 'OpenChamberWidget.entitlements'),
  join(iosAppDir, 'OpenChamberNotificationService', 'OpenChamberNotificationService.entitlements'),
  join(iosAppDir, 'OpenChamberShareExtension', 'OpenChamberShareExtension.entitlements'),
];

const appGroupSourcePaths = [
  join(iosAppDir, 'App', 'OpenChamberShareStore.swift'),
  join(iosAppDir, 'App', 'AppDelegate.swift'),
  join(iosAppDir, 'OpenChamberWidget', 'WidgetShared.swift'),
  join(iosAppDir, 'OpenChamberNotificationService', 'NotificationService.swift'),
];

const run = (command, args, cwd = mobileRoot) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }
};

const stripPush = (contents) =>
  contents.replace(/\n\t<key>aps-environment<\/key>\n\t<string>[^<]+<\/string>/, '');

const rewriteAppGroup = (contents) =>
  contents.replaceAll(productionAppGroup, devAppGroup);

const patchTextFiles = (paths, transform) =>
  paths.map((path) => {
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, transform(original));
    return { path, original };
  });

const restoreTextFiles = (backups) => {
  for (const { path, original } of backups) {
    writeFileSync(path, original);
  }
};

const patchEntitlements = () =>
  patchTextFiles(entitlementPaths, (contents) => rewriteAppGroup(stripPush(contents)));

const patchAppGroupSources = () =>
  patchTextFiles(appGroupSourcePaths, rewriteAppGroup);

const patchBundleIdentifiers = () => {
  const original = readFileSync(pbxprojPath, 'utf8');
  let patched = original;
  for (const [from, to] of bundleIdReplacements) {
    patched = patched.replaceAll(from, to);
  }
  writeFileSync(pbxprojPath, patched);
  return original;
};

const restoreBundleIdentifiers = (original) => {
  writeFileSync(pbxprojPath, original);
};

const deviceDestination = () => {
  if (process.env.IOS_DEVICE_UDID) {
    return `id=${process.env.IOS_DEVICE_UDID}`;
  }

  // xcodebuild wants the hardware UDID (00008130-...), not the CoreDevice
  // identifier shown by `devicectl list devices` (45734939-...). Prefer
  // xcodebuild destinations; fall back to a generic iOS device build.
  const result = spawnSync('xcodebuild', [
    '-workspace', 'ios/App/App.xcworkspace',
    '-scheme', 'App',
    '-showdestinations',
  ], {
    encoding: 'utf8',
    cwd: mobileRoot,
    env: process.env,
  });
  if (result.status === 0) {
    const match = (result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.match(/\{ platform:iOS, arch:[^,]+, id:([^,]+), name:(.+) \}/))
      .find((entry) => entry && !entry[1].includes('placeholder'));
    if (match?.[1]) {
      return `id=${match[1]}`;
    }
  }

  return 'generic/platform=iOS';
};

// 1. Build the web bundle and copy it into the iOS project (no pod regen — `copy`, not `sync`).
if (process.env.SKIP_MOBILE_WEB_BUILD !== '1') {
  run('bun', ['run', 'build']);
}
run('bunx', ['cap', 'copy', 'ios']);

// 2. Patch entitlements, App Group sources, and bundle IDs for Personal Team signing.
const entitlementBackups = patchEntitlements();
const sourceBackups = patchAppGroupSources();
const originalPbxproj = patchBundleIdentifiers();

try {
  run('xcodebuild', [
    '-workspace', 'ios/App/App.xcworkspace',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphoneos',
    '-destination', deviceDestination(),
    '-allowProvisioningUpdates',
    `DEVELOPMENT_TEAM=${developmentTeam}`,
    'build',
  ]);
} finally {
  // 3. Always restore project files so git/release builds keep production IDs + capabilities.
  restoreTextFiles(entitlementBackups);
  restoreTextFiles(sourceBackups);
  restoreBundleIdentifiers(originalPbxproj);
}

console.log('[ios-device-build] Device build complete. Run `bun run ios:run` to install + launch.');
