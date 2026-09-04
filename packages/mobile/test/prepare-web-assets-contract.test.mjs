import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  COPY_WEB_DIST_DEADLINE_MS,
  COPY_WEB_DIST_RETRY_MS,
  copyWebDistUntilMobileHtmlExists,
  rewriteNativeViewport,
} from '../scripts/prepare-web-assets.mjs';

const VIEWPORT_HTML = '<meta name="viewport" content="width=device-width, viewport-fit=cover">';

test('copy retry constants stay long enough for a sibling Vite emptyOutDir race', () => {
  assert.equal(COPY_WEB_DIST_DEADLINE_MS, 120_000);
  assert.equal(COPY_WEB_DIST_RETRY_MS, 250);
});

test('copyWebDistUntilMobileHtmlExists retries ENOENT until mobile.html is readable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-mobile-assets-'));
  const webDist = path.join(root, 'web');
  const mobileDist = path.join(root, 'mobile');
  await mkdir(webDist, { recursive: true });
  await writeFile(path.join(webDist, 'placeholder.txt'), 'ready');

  let attempts = 0;
  const html = await copyWebDistUntilMobileHtmlExists({
    webDist,
    mobileDist,
    deadlineMs: 5_000,
    retryMs: 0,
    sleep: async () => {
      attempts += 1;
      if (attempts === 1) {
        await writeFile(path.join(webDist, 'mobile.html'), VIEWPORT_HTML);
      }
    },
  });

  assert.equal(html, VIEWPORT_HTML);
  assert.ok(attempts >= 1, 'must retry after the first missing mobile.html');
  assert.equal(await readFile(path.join(mobileDist, 'mobile.html'), 'utf8'), VIEWPORT_HTML);
  await rm(root, { recursive: true, force: true });
});

test('copyWebDistUntilMobileHtmlExists rethrows non-ENOENT errors immediately', async () => {
  const permission = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  await assert.rejects(
    () => copyWebDistUntilMobileHtmlExists({
      webDist: '/unused-web',
      mobileDist: '/unused-mobile',
      fs: {
        rm: async () => {
          throw permission;
        },
        mkdir: async () => {},
        cp: async () => {},
        readFile: async () => '',
      },
    }),
    (error) => error === permission,
  );
});

test('copyWebDistUntilMobileHtmlExists throws the last ENOENT after the deadline', async () => {
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  let now = 0;
  await assert.rejects(
    () => copyWebDistUntilMobileHtmlExists({
      webDist: '/unused-web',
      mobileDist: '/unused-mobile',
      deadlineMs: 1,
      retryMs: 0,
      now: () => now,
      sleep: async () => {
        now += 2;
      },
      fs: {
        rm: async () => {},
        mkdir: async () => {},
        cp: async () => {},
        readFile: async () => {
          throw missing;
        },
      },
    }),
    (error) => error === missing,
  );
});

test('rewriteNativeViewport stamps interactive-widget overlays-content', () => {
  assert.equal(
    rewriteNativeViewport(VIEWPORT_HTML),
    '<meta name="viewport" content="width=device-width, viewport-fit=cover, interactive-widget=overlays-content">',
  );
});

test('rewriteNativeViewport fails when the viewport meta is missing', () => {
  assert.throws(
    () => rewriteNativeViewport('<html></html>'),
    /viewport meta tag was not found/,
  );
});
