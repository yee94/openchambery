import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncDownloads } from './sync-downloads.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const invitation = 'https://testflight.apple.com/join/Example1';
function release(version, overrides = {}) {
  return {
    tag_name: `v${version}`, prerelease: version.includes('-'), draft: false,
    published_at: '2026-10-26T00:00:00Z',
    assets: ['mac-arm64.dmg', 'win-x64.exe', 'linux-x86_64.AppImage', 'linux-arm64.AppImage', 'app-release.apk'].map((suffix) => {
      const name = suffix === 'app-release.apk' ? suffix : `Yuri-${version}-${suffix}`;
      return { name, browser_download_url: `https://github.com/yee94/yuri/releases/download/v${version}/${name}` };
    }),
    ...overrides,
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'yuri-site-releases-'));
  roots.push(root);
  const sourcePath = path.join(root, 'downloads.mjs');
  const source = await readFile(new URL('./assets/downloads.mjs', import.meta.url), 'utf8');
  await writeFile(sourcePath, source);
  return { sourcePath, source };
}

describe('CI release snapshot', () => {
  it('writes verified stable assets and the configured invitation into the browser/static snapshot', async () => {
    const f = await fixture();
    const fetchImpl = vi.fn(async () => Response.json([
      release('0.1.2-beta.2'), release('0.1.1'),
      release('0.1.2', { draft: true }),
      release('9.0.0', { tag_name: 'mobile-stable/v9.0.0' }),
    ]));
    const result = await syncDownloads({ sourcePath: f.sourcePath, fetchImpl, token: 'fixture-token', testFlightUrl: invitation });
    expect(result).toMatchObject({ version: '0.1.1', prerelease: false, targets: { ios: invitation } });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');
    const source = await readFile(f.sourcePath, 'utf8');
    const generated = source.match(/\/\* release-snapshot:start \*\/ Object.freeze\(([\s\S]*?)\) \/\* release-snapshot:end \*\//);
    expect(JSON.parse(generated[1])).toEqual(result);
    expect(source).not.toContain('fixture-token');
    expect(source.slice(source.indexOf('/** Select'))).toBe(f.source.slice(f.source.indexOf('/** Select')));
  });

  it('fails closed without changing the snapshot on rate limits, empty catalogs or missing installers', async () => {
    const f = await fixture();
    for (const response of [new Response('', { status: 403 }), Response.json([]), Response.json([release('1.0.0', { assets: [] })])]) {
      await expect(syncDownloads({ sourcePath: f.sourcePath, fetchImpl: async () => response, testFlightUrl: invitation })).rejects.toThrow();
      expect(await readFile(f.sourcePath, 'utf8')).toBe(f.source);
    }
  });
});
