import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createAssetZip } from '../../../packages/web/server/lib/zip-assets.js';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { selectOtaMajor } from '../lib/ota-manifest.js';
import { handleMobileUpdateCheck } from '../lib/ota-check.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('publishing and rollout retain both majors, channels and referenced bundles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ota-major-'));
  const channels = new Map();
  const bundles = new Map();
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/mobile/update/check') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await handleMobileUpdateCheck(new Request(`http://${req.headers.host}${req.url}`, {
          method: 'POST', body: Buffer.concat(chunks),
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    const channel = req.url.match(/^\/ota\/channels\/(beta|stable)\.json$/)?.[1];
    const bundle = req.url.match(/^\/ota\/bundles\/([a-f0-9]+)\.zip$/)?.[1];
    const data = channel ? channels.get(channel) : bundles.get(bundle);
    res.statusCode = data ? 200 : 404;
    res.end(data ?? 'missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, OTA_BASE_URL: `http://127.0.0.1:${server.address().port}`, MIN_SHELL_RELEASE_VERSION: '' };
  let sequence = 0;
  const publish = async (version, channel = 'beta') => {
    const zip = path.join(dir, `input-${++sequence}.zip`);
    const bytes = Buffer.from(`bundle ${version}`);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await writeFile(zip, bytes);
    const desktopDir = path.join(dir, `desktop-${sequence}`);
    await mkdir(desktopDir);
    await writeFile(path.join(desktopDir, 'desktop-ota.json'), JSON.stringify({ releaseVersion: version, shellFingerprint: 'a'.repeat(64) }));
    await writeFile(path.join(desktopDir, 'index.html'), '<html>Desktop</html>');
    const desktopZip = `${desktopDir}.zip`;
    createAssetZip(desktopDir, desktopZip);
    const out = path.join(dir, `snapshot-${sequence}`);
    await exec(process.execPath, ['scripts/mobile-ota/assemble-snapshot.mjs', '--zip', zip,
      '--desktop-zip', desktopZip, '--version', version, '--channel', channel, '--checksum', checksum, '--out', out], { cwd: root, env });
    for (const name of ['beta', 'stable']) {
      channels.set(name, await readFile(path.join(out, 'ota/channels', `${name}.json`)));
    }
    bundles.set(checksum.slice(0, 16), bytes);
    const desktopBytes = await readFile(desktopZip);
    bundles.set(createHash('sha256').update(desktopBytes).digest('hex').slice(0, 16), desktopBytes);
    for (const [id, contents] of bundles) {
      assert.deepEqual(await readFile(path.join(out, 'ota/bundles', `${id}.zip`)), contents);
    }
    return JSON.parse(channels.get(channel));
  };
  try {
    await publish('1.20.0', 'stable');
    const one = await publish('1.20.0-beta.1');
    const two = await publish('2.0.0-beta.24');
    assert.deepEqual(selectOtaMajor(two, 1), one);
    const oneAgain = await publish('1.20.0-beta.2');
    assert.equal(oneAgain.activeBundle.releaseVersion, '1.20.0-beta.2');
    assert.deepEqual(selectOtaMajor(oneAgain, 2), selectOtaMajor(two, 2));
    assert.equal(oneAgain.rollbackBundleIds[0], one.activeBundle.bundleId);
    await exec(process.execPath, ['scripts/mobile-ota/verify-detectability.mjs',
      '--channel', 'beta', '--version', '2.0.0-beta.24', '--base', env.OTA_BASE_URL], { cwd: root, env, timeout: 10_000 });
    const out = path.join(dir, 'paused');
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'pause', '--major', '2', '--out', out], { cwd: root, env });
    const paused = JSON.parse(await readFile(path.join(out, 'ota/channels/beta.json'), 'utf8'));
    assert.equal(selectOtaMajor(paused, 2).activeBundle.rolloutPercent, 0);
    assert.deepEqual(selectOtaMajor(paused, 1), selectOtaMajor(oneAgain, 1));
    for (const id of bundles.keys()) await readFile(path.join(out, 'ota/bundles', `${id}.zip`));
    const rollbackOut = path.join(dir, 'rollback');
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'rollback', '--major', '1', '--out', rollbackOut], { cwd: root, env });
    const rolledBack = selectOtaMajor(JSON.parse(await readFile(path.join(rollbackOut, 'ota/channels/beta.json'), 'utf8')), 1);
    assert.equal(rolledBack.activeBundle.releaseVersion, one.activeBundle.releaseVersion);
    assert.deepEqual(rolledBack.activeBundle.desktop, one.activeBundle.desktop);
    assert.equal(rolledBack.activeBundle.checksum, one.activeBundle.checksum);
    for (const id of bundles.keys()) await readFile(path.join(rollbackOut, 'ota/bundles', `${id}.zip`));
    await assert.rejects(() => publish('1.19.0-beta.1'), /older than active/);
    const corrupt = JSON.parse(channels.get('beta'));
    corrupt.majorReleases['2'].activeBundle.releaseVersion = '3.0.0';
    channels.set('beta', JSON.stringify(corrupt));
    await assert.rejects(() => publish('1.20.0-beta.3'), /manifest invalid/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
