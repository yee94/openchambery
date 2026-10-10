import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetZip } from '../packages/web/server/lib/zip-assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The fingerprint covers executable shell/backend sources and dependency locks,
// independent of build host, generated resources and the marketing version.
export async function desktopShellFingerprint() {
  const hash = createHash('sha256');
  async function visit(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'dist-bundle', 'resources', 'scripts'].includes(entry.name)) await visit(name);
      } else if (/\.(?:m?js|cjs|json)$/.test(name) && !/\.(?:test|spec)\./.test(name) && entry.name !== 'package.json') {
        hash.update(name).update(await readFile(path.join(root, name)));
      }
    }
  }
  await visit('packages/electron');
  await visit('packages/web/server');
  for (const name of ['package.json', 'packages/electron/package.json', 'packages/web/package.json']) {
    const pkg = JSON.parse(await readFile(path.join(root, name), 'utf8'));
    hash.update(name).update(JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, build: pkg.build }));
  }
  for (const name of ['deploy/update-service/lib/semver.js', 'packages/electron/scripts/bundle-main.mjs']) {
    hash.update(name).update(await readFile(path.join(root, name)));
  }
  const lockfile = await readFile(path.join(root, 'bun.lock'), 'utf8');
  // Workspace marketing versions change on every release. Only pinned package
  // resolutions belong in the native fingerprint; declarations are hashed above.
  const packagesOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesOffset < 0) throw new Error('Unsupported Bun lockfile: missing package resolutions');
  hash.update(lockfile.slice(packagesOffset));
  return hash.digest('hex');
}

export async function writeDesktopAssetMetadata(directory) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const metadata = { releaseVersion: version, shellFingerprint: await desktopShellFingerprint() };
  await writeFile(path.join(directory, 'desktop-ota.json'), JSON.stringify(metadata));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.join(root, 'packages/web/dist');
  await writeDesktopAssetMetadata(directory);
  createAssetZip(directory, path.resolve(process.argv[2] ?? 'desktop-ota.zip'));
}
