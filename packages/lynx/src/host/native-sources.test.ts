import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '../../host');

describe('native host sources', () => {
  test('iOS host mirrors Mode B tab chrome and never adds a Chat tab', async () => {
    const host = await readFile(join(hostRoot, 'ios/OpenChamberLynxHostController.swift'), 'utf8');
    const embedding = await readFile(join(hostRoot, 'ios/OpenChamberLynxEmbedding.swift'), 'utf8');
    expect(embedding).toContain('liquidGlassTabBarMajor = 26');
    expect(host).toContain('projects');
    expect(host).toContain('assistant');
    expect(host).toContain('scheduled');
    expect(host).toContain('settings');
    expect(host).toContain('Chat is never a tab item');
    expect(host).not.toMatch(/tabIds = \[[^\]]*chat/);
  });

  test('Android host is Mode A with blur downgrade and no Material twin dock', async () => {
    const activityMirror = await readFile(join(hostRoot, 'android/OpenChamberLynxHostActivity.kt'), 'utf8');
    const activity = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxHostActivity.kt'),
      'utf8',
    );
    const embedding = await readFile(join(hostRoot, 'android/OpenChamberLynxEmbedding.kt'), 'utf8');
    const app = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxApp.kt'),
      'utf8',
    );
    expect(embedding).toContain('androidGlassDowngrade = true');
    expect(activityMirror).toContain('Do not add a fifth Chat destination');
    expect(activityMirror).toContain('com.yee94.openchamber.lynx.debug');
    expect(activity).toContain('Do not add a fifth Chat destination');
    expect(activity).toContain('com.yee94.openchamber.lynx.debug');
    expect(activity).toContain('renderTemplateUrl');
    expect(activity).toContain('AppCompatActivity');
    expect(activity).toContain('MATCH_PARENT');
    expect(activity).toContain('setPresetMeasuredSpec');
    expect(activity).toContain('updateGlobalProps');
    expect(activity).toContain('TemplateData.fromMap');
    expect(activity).toContain('addLynxViewClient');
    expect(activity).toContain('OpenChamberLynx');
    expect(app).toContain('LynxEnv.inst()');
    const themes = await readFile(
      join(hostRoot, 'android/app/src/main/res/values/themes.xml'),
      'utf8',
    );
    expect(themes).toContain('lynx_window_background');
    expect(themes).not.toContain('@android:color/black');
    const colors = await readFile(
      join(hostRoot, 'android/app/src/main/res/values/colors.xml'),
      'utf8',
    );
    expect(colors).toContain('#fffdf4');
    const viewFactory = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxViewFactory.kt'),
      'utf8',
    );
    expect(viewFactory).toContain('"platform" to "android"');
    expect(viewFactory).toContain('"chromeOwner"');
    expect(viewFactory).toContain('"locale"');
    expect(viewFactory).toContain('"safeAreaTop"');
    expect(viewFactory).toContain('"safeAreaBottom"');
  });

  test('host scaffold includes deepened bridge protocols', async () => {
    const iosBridge = await readFile(join(hostRoot, 'ios/OpenChamberLynxBridge.swift'), 'utf8');
    const iosCamera = await readFile(join(hostRoot, 'ios/OpenChamberLynxCameraAdapter.swift'), 'utf8');
    const iosAsset = await readFile(join(hostRoot, 'ios/OpenChamberLynxVirtualAsset.swift'), 'utf8');
    const iosBack = await readFile(join(hostRoot, 'ios/OpenChamberLynxPredictiveBack.swift'), 'utf8');
    const iosHttp = await readFile(join(hostRoot, 'ios/OpenChamberLynxHttpClient.swift'), 'utf8');
    const iosSecure = await readFile(join(hostRoot, 'ios/OpenChamberLynxSecureStore.swift'), 'utf8');
    const iosOauth = await readFile(join(hostRoot, 'ios/OpenChamberLynxOAuthBrowser.swift'), 'utf8');
    const iosIme = await readFile(join(hostRoot, 'ios/OpenChamberLynxImeInset.swift'), 'utf8');
    const androidBridge = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxBridge.kt'),
      'utf8',
    );
    const androidSecure = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxSecureStore.kt'),
      'utf8',
    );
    const androidOauth = await readFile(
      join(hostRoot, 'android/app/src/main/java/com/yee94/openchamber/lynx/OpenChamberLynxOAuthBrowser.kt'),
      'utf8',
    );
    const podfile = await readFile(join(hostRoot, 'ios/Podfile'), 'utf8');
    const gradle = await readFile(join(hostRoot, 'android/app/build.gradle'), 'utf8');
    const manifest = await readFile(join(hostRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const readme = await readFile(join(hostRoot, 'README.md'), 'utf8');
    expect(iosBridge).toContain('scanPairingQr');
    expect(iosBridge).toContain('openOAuthAuthorize');
    expect(iosBridge).toContain('qrScanResult');
    expect(iosCamera).toContain('.unavailable');
    expect(iosAsset).toContain('openchamber-asset');
    expect(iosAsset).toContain('registerSchemeHandler');
    expect(iosBack).toContain('PredictiveBack');
    expect(iosHttp).toContain('URLSession');
    expect(iosSecure).toContain('SecItemCopyMatching');
    expect(iosSecure).toContain('kSecAttrAccessibleWhenUnlocked');
    expect(iosOauth).toContain('ASWebAuthenticationSession');
    expect(iosIme).toContain('keyboardWillChangeFrameNotification');
    expect(iosIme).toContain('ABOVE glass');
    expect(androidBridge).toContain('ScanPairingQr');
    expect(androidBridge).toContain('OpenOAuthAuthorize');
    expect(androidSecure).toContain('EncryptedSharedPreferences');
    expect(androidOauth).toContain('CustomTabsIntent');
    expect(podfile).toContain("platform :ios");
    expect(gradle).toContain("applicationId 'com.yee94.openchamber.lynx'");
    expect(gradle).toContain("applicationIdSuffix '.debug'");
    expect(gradle).toContain('org.lynxsdk.lynx:lynx:4.0.0');
    expect(gradle).toContain('signingConfig signingConfigs.debug');
    expect(manifest).toContain('enableOnBackInvokedCallback');
    expect(manifest).toContain('openchamber-lynx');
    expect(manifest).toContain('.OpenChamberLynxApp');
    expect(readme).toContain('Mac / device run steps');
    expect(readme).toContain('ASWebAuthenticationSession');
  });

  test('lynx-ci + lynx-mobile-ci workflows are live under .github/workflows', async () => {
    const template = await readFile(join(hostRoot, '../ci/lynx-ci.yml'), 'utf8');
    const lynxCi = await readFile(join(hostRoot, '../../../.github/workflows/lynx-ci.yml'), 'utf8');
    const mobileCi = await readFile(join(hostRoot, '../../../.github/workflows/lynx-mobile-ci.yml'), 'utf8');
    expect(template).toContain('name: lynx-ci');
    expect(template).toContain('work/lynx-native');
    expect(template).toContain('build:rspeedy');
    expect(lynxCi).toContain('name: lynx-ci');
    expect(lynxCi).toContain('work/lynx-native');
    expect(lynxCi).toContain('build:rspeedy');
    expect(mobileCi).toContain('Android sideload APK');
    expect(mobileCi).toContain('lynx-v2-debug-');
    expect(mobileCi).toContain('assembleRelease');
  });
});
