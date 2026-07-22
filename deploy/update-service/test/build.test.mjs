import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
  } finally {
    rmSync(outputPath, { recursive: true, force: true });
  }
});
