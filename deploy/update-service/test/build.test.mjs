import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('build emits an update manifest from the published release manifest and changelog', () => {
  const outputDirectory = `.test-dist-${process.pid}-${Date.now()}`;
  const outputPath = path.join(projectRoot, outputDirectory);

  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, OPENCHAMBER_UPDATE_OUTPUT_DIR: outputDirectory },
      stdio: 'pipe',
    });

    const sourceManifest = JSON.parse(readFileSync(path.join(projectRoot, 'release-manifest.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(outputPath, 'update-manifest.json'), 'utf8'));
    const health = JSON.parse(readFileSync(path.join(outputPath, 'health.json'), 'utf8'));

    assert.deepEqual(manifest, sourceManifest);
    assert.deepEqual(health, { service: 'openchamber-update', latestVersion: sourceManifest.latestVersion });
    assert.equal(existsSync(path.join(outputPath, 'CHANGELOG.md')), true);

    const betaChannel = JSON.parse(readFileSync(path.join(outputPath, 'ota', 'channels', 'beta.json'), 'utf8'));
    assert.equal(betaChannel.schemaVersion, 1);
    assert.equal(betaChannel.channel, 'beta');
    assert.equal(betaChannel.activeBundle, null);

    const stableChannel = JSON.parse(readFileSync(path.join(outputPath, 'ota', 'channels', 'stable.json'), 'utf8'));
    assert.equal(stableChannel.schemaVersion, 1);
    assert.equal(stableChannel.channel, 'stable');
    assert.equal(stableChannel.activeBundle, null);
  } finally {
    rmSync(outputPath, { recursive: true, force: true });
  }
});

test('EdgeOne build skips OTA seed tree and CHANGELOG so edge proxies are not shadowed', () => {
  const outputDirectory = `.test-dist-edgeone-${process.pid}-${Date.now()}`;
  const outputPath = path.join(projectRoot, outputDirectory);

  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENCHAMBER_UPDATE_OUTPUT_DIR: outputDirectory,
        OPENCHAMBER_UPDATE_SKIP_OTA_COPY: '1',
        OPENCHAMBER_UPDATE_SKIP_CHANGELOG_COPY: '1',
      },
      stdio: 'pipe',
    });

    assert.equal(existsSync(path.join(outputPath, 'update-manifest.json')), true);
    assert.equal(existsSync(path.join(outputPath, 'health.json')), true);
    assert.equal(existsSync(path.join(outputPath, 'CHANGELOG.md')), false);
    assert.equal(existsSync(path.join(outputPath, 'ota')), false);
  } finally {
    rmSync(outputPath, { recursive: true, force: true });
  }
});
