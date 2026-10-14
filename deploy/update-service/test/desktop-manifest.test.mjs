import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createDesktopManifestHandler, rewriteRelativeAssetUrls } from '../lib/desktop-manifest.js';

test('rewrites relative Electron updater asset urls to GitHub release downloads', () => {
  const rewritten = rewriteRelativeAssetUrls([
    'version: 1.16.50',
    'path: OpenChamber-1.16.50-win-x64.exe',
    '  - url: "OpenChamber-1.16.50-win-x64.exe.blockmap"',
    'url: https://example.com/asset',
    'path: ../outside',
  ].join('\n'));

  assert.match(rewritten, /path: https:\/\/github\.com\/yee94\/openchamber\/releases\/latest\/download\/OpenChamber-1\.16\.50-win-x64\.exe/);
  assert.match(rewritten, /- url: "https:\/\/github\.com\/yee94\/openchamber\/releases\/latest\/download\/OpenChamber-1\.16\.50-win-x64\.exe\.blockmap"/);
  assert.match(rewritten, /url: https:\/\/example\.com\/asset/);
  assert.match(rewritten, /path: \.\.\/outside/);
});

test('serves the current full feed when a legacy latest filename is requested', async () => {
  const requested = [];
  const handler = createDesktopManifestHandler('latest-linux-arm64.yml', async (url) => {
    requested.push(url);
    return new Response([
      '{',
      '  "files": [',
      '    {',
      '      "url": "OpenChamber-2.1.0-linux-arm64.AppImage",',
      '      "sha512": "abc",',
      '      "size": 1',
      '    }',
      '  ],',
      '  "path": "OpenChamber-2.1.0-linux-arm64.AppImage",',
      '  "sha512": "abc"',
      '}',
    ].join('\n'), { status: 200 });
  });
  const response = await handler();

  assert.deepEqual(requested, [
    'https://github.com/yee94/openchamber/releases/latest/download/full-linux-arm64.yml',
  ]);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"path": "https:\/\/github\.com\/yee94\/openchamber\/releases\/latest\/download\/OpenChamber-2\.1\.0-linux-arm64\.AppImage",/);
  assert.match(body, /"url": "https:\/\/github\.com\/yee94\/openchamber\/releases\/latest\/download\/OpenChamber-2\.1\.0-linux-arm64\.AppImage"/);
});

test('falls back to the legacy feed name only when the current feed is missing', async () => {
  const requested = [];
  const handler = createDesktopManifestHandler('latest-mac.yml', async (url) => {
    requested.push(url);
    if (url.endsWith('/full-mac.yml')) return new Response('', { status: 404 });
    return new Response('path: OpenChamber-2.0.0-mac-arm64.zip\n', { status: 200 });
  });
  const response = await handler();

  assert.deepEqual(requested, [
    'https://github.com/yee94/openchamber/releases/latest/download/full-mac.yml',
    'https://github.com/yee94/openchamber/releases/latest/download/latest-mac.yml',
  ]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /path: https:\/\/github\.com\/yee94\/openchamber\/releases\/latest\/download\/OpenChamber-2\.0\.0-mac-arm64\.zip/);
});

test('passes upstream manifest availability failures through', async () => {
  const handler = createDesktopManifestHandler('latest.yml', async () => new Response('', { status: 404 }));
  const response = await handler();
  assert.equal(response.status, 404);
});
