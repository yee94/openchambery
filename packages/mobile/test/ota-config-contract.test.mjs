import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);
const rootDir = fileURLToPath(root);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function listSrcTsFiles(dir = join(rootDir, 'src')) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSrcTsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

test('capacitor.config.ts declares CapacitorUpdater and OpenChamberOTA OTA contracts', async () => {
  const config = await source('capacitor.config.ts');

  assert.match(config, /CapacitorUpdater:\s*\{/);
  assert.match(config, /updateUrl:\s*process\.env\.OPENCHAMBER_OTA_UPDATE_URL\s*\?\?/);
  assert.match(
    config,
    /const otaChannel\s*=\s*process\.env\.OPENCHAMBER_OTA_CHANNEL\s*===\s*'stable'\s*\?\s*'stable'\s*:\s*'beta'/,
  );
  assert.match(config, /defaultChannel:\s*otaChannel/);
  assert.match(config, /statsUrl:\s*''/);
  assert.match(config, /appReadyTimeout:\s*20000/);
  assert.match(config, /autoUpdate:\s*false/);
  assert.match(config, /autoDeleteFailed:\s*true/);
  assert.match(config, /autoDeletePrevious:\s*true/);
  assert.match(config, /resetWhenUpdate:\s*true/);
  assert.match(config, /publicKey:\s*process\.env\.OPENCHAMBER_OTA_PUBLIC_KEY\s*\?\?\s*''/);

  assert.match(config, /OpenChamberOTA:\s*\{/);
  assert.match(config, /channel:\s*otaChannel/);
  assert.match(config, /shellApiVersion:\s*1/);
});

test('openchamber-ota.ts registers a local CapacitorUpdater bridge without package imports', async () => {
  const ota = await source('src/openchamber-ota.ts');

  assert.match(ota, /registerPlugin<OpenChamberUpdaterPlugin>\(\s*'CapacitorUpdater'\s*\)/);
  assert.match(ota, /notifyAppReady\(\)/);
  assert.match(ota, /download\(options:\s*OpenChamberOtaDownloadOptions\)/);
  assert.match(ota, /next\(options:\s*\{\s*id:\s*string\s*\}\)/);
  assert.match(ota, /reload\(\)/);
  assert.match(ota, /current\(\)/);
  assert.match(ota, /getDeviceId\(\)/);

  for (const eventName of [
    'downloadComplete',
    'appReady',
    'appReloaded',
    'autoRevert',
    'noNeedUpdate',
    'majorAvailable',
    'downloadFailed',
    'updateFailed',
  ]) {
    assert.match(ota, new RegExp(`['"]${eventName}['"]`));
  }

  assert.match(ota, /addListener\(/);
  assert.match(ota, /removeListener\(/);
  assert.match(ota, /PluginListenerHandle/);
  assert.doesNotMatch(ota, /@capgo\/capacitor-updater/);
});

test('src files never import @capgo/capacitor-updater (local declaration contract)', async () => {
  const files = await listSrcTsFiles();
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(
      content,
      /@capgo\/capacitor-updater/,
      `${file} must not import @capgo/capacitor-updater`,
    );
  }
});

test('OTA channel and shellApiVersion constants match capacitor.config.ts', async () => {
  const [config, ota] = await Promise.all([source('capacitor.config.ts'), source('src/openchamber-ota.ts')]);

  const channelConst = ota.match(/export const OPENCHAMBER_OTA_CHANNEL\s*=\s*'([^']+)'/)?.[1];
  const shellConst = ota.match(/export const OPENCHAMBER_SHELL_API_VERSION\s*=\s*(\d+)/)?.[1];
  assert.ok(channelConst, 'OPENCHAMBER_OTA_CHANNEL missing');
  assert.ok(shellConst, 'OPENCHAMBER_SHELL_API_VERSION missing');
  assert.equal(channelConst, 'beta', 'OPENCHAMBER_OTA_CHANNEL build default must be beta');

  // Value object uses otaChannel derived from OPENCHAMBER_OTA_CHANNEL env.
  assert.match(
    config,
    /const otaChannel\s*=\s*process\.env\.OPENCHAMBER_OTA_CHANNEL\s*===\s*'stable'\s*\?\s*'stable'\s*:\s*'beta'/,
  );
  const openChamberBlock = config.match(/OpenChamberOTA:\s*\{\s*channel:\s*otaChannel,\s*shellApiVersion:\s*(\d+),\s*\}/);
  assert.ok(openChamberBlock, 'OpenChamberOTA value block missing');
  assert.equal(openChamberBlock[1], shellConst);

  const updaterBlock = config.match(/CapacitorUpdater:\s*\{([\s\S]*?)\n\s*\},/)?.[1];
  assert.ok(updaterBlock, 'CapacitorUpdater block missing');
  assert.match(updaterBlock, /defaultChannel:\s*otaChannel/);
});
