import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopManifestHandler, rewriteRelativeAssetUrls } from '../edge-functions/desktop-manifest.js';

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

test('proxies only the selected allowed updater manifest filename', async () => {
  let requestedUrl;
  const handler = createDesktopManifestHandler('latest-linux-arm64.yml', async (url) => {
    requestedUrl = url;
    return new Response('path: OpenChamber.AppImage\n', { status: 200 });
  });
  const response = await handler();

  assert.equal(requestedUrl, 'https://github.com/yee94/openchamber/releases/latest/download/latest-linux-arm64.yml');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'path: https://github.com/yee94/openchamber/releases/latest/download/OpenChamber.AppImage\n');
});

test('passes upstream manifest availability failures through', async () => {
  const handler = createDesktopManifestHandler('latest.yml', async () => new Response('', { status: 404 }));
  const response = await handler();
  assert.equal(response.status, 404);
});
