import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.resolve(mobileRoot, '../web/dist');
const mobileDist = path.resolve(mobileRoot, 'dist');
const mobileHtml = path.join(mobileDist, 'mobile.html');
const indexHtml = path.join(mobileDist, 'index.html');

await rm(mobileDist, { recursive: true, force: true });
await mkdir(mobileDist, { recursive: true });
await cp(webDist, mobileDist, { recursive: true });

const html = await readFile(mobileHtml, 'utf8');
// Android's composer owns IME geometry through its transform FLIP. Keep the
// native WebView viewport stable so Chromium cannot add a second layout lift.
const nativeHtml = html.replace(
  'viewport-fit=cover"',
  'viewport-fit=cover, interactive-widget=overlays-content"',
);

if (nativeHtml === html) {
  throw new Error('Mobile viewport meta tag was not found while preparing native assets');
}

await writeFile(indexHtml, nativeHtml);
