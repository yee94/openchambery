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
    const activity = await readFile(join(hostRoot, 'android/OpenChamberLynxHostActivity.kt'), 'utf8');
    const embedding = await readFile(join(hostRoot, 'android/OpenChamberLynxEmbedding.kt'), 'utf8');
    expect(embedding).toContain('androidGlassDowngrade = true');
    expect(activity).toContain('Do not add a fifth Chat destination');
    expect(activity).toContain('com.yee94.openchamber');
  });

  test('host scaffold includes bridge/camera/virtual-asset/predictive-back stubs', async () => {
    const iosBridge = await readFile(join(hostRoot, 'ios/OpenChamberLynxBridge.swift'), 'utf8');
    const iosCamera = await readFile(join(hostRoot, 'ios/OpenChamberLynxCameraAdapter.swift'), 'utf8');
    const iosAsset = await readFile(join(hostRoot, 'ios/OpenChamberLynxVirtualAsset.swift'), 'utf8');
    const iosBack = await readFile(join(hostRoot, 'ios/OpenChamberLynxPredictiveBack.swift'), 'utf8');
    const podfile = await readFile(join(hostRoot, 'ios/Podfile'), 'utf8');
    const gradle = await readFile(join(hostRoot, 'android/app/build.gradle'), 'utf8');
    const manifest = await readFile(join(hostRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const readme = await readFile(join(hostRoot, 'README.md'), 'utf8');
    expect(iosBridge).toContain('OpenChamberLynxBridge');
    expect(iosCamera).toContain('.unavailable');
    expect(iosAsset).toContain('openchamber-asset');
    expect(iosBack).toContain('PredictiveBack');
    expect(podfile).toContain("platform :ios");
    expect(gradle).toContain("applicationId 'com.yee94.openchamber'");
    expect(manifest).toContain('enableOnBackInvokedCallback');
    expect(readme).toContain('Mac / device run steps');
  });

  test('lynx-ci workflow template is ready under packages/lynx/ci', async () => {
    const workflow = await readFile(join(hostRoot, '../ci/lynx-ci.yml'), 'utf8');
    expect(workflow).toContain('name: lynx-ci');
    expect(workflow).toContain('work/lynx-native');
    expect(workflow).toContain('build:rspeedy');
  });
});
