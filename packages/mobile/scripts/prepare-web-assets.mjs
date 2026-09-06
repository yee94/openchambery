import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = path.resolve(mobileRoot, '../web/dist');
export const MOBILE_DIST = path.resolve(mobileRoot, 'dist');
export const COPY_WEB_DIST_DEADLINE_MS = 120_000;
export const COPY_WEB_DIST_RETRY_MS = 250;

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const defaultFs = { rm, mkdir, cp, readFile };

// Workspace `bun run --filter '*' build` runs this package in parallel with
// `@openchambery/web`, while this script also invokes the web build. The other
// web job can empty `packages/web/dist` between our copy and the read.
export const copyWebDistUntilMobileHtmlExists = async ({
  webDist = WEB_DIST,
  mobileDist = MOBILE_DIST,
  deadlineMs = COPY_WEB_DIST_DEADLINE_MS,
  retryMs = COPY_WEB_DIST_RETRY_MS,
  now = Date.now,
  sleep = defaultSleep,
  fs = defaultFs,
} = {}) => {
  const mobileHtml = path.join(mobileDist, 'mobile.html');
  const deadline = now() + deadlineMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      await fs.rm(mobileDist, { recursive: true, force: true });
      await fs.mkdir(mobileDist, { recursive: true });
      await fs.cp(webDist, mobileDist, { recursive: true });
      return await fs.readFile(mobileHtml, 'utf8');
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') throw error;
      await sleep(retryMs);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${mobileHtml}`);
};

export const rewriteNativeViewport = (html) => {
  const nativeHtml = html.replace(
    'viewport-fit=cover"',
    'viewport-fit=cover, interactive-widget=overlays-content"',
  );
  if (nativeHtml === html) {
    throw new Error('Mobile viewport meta tag was not found while preparing native assets');
  }
  return nativeHtml;
};

const isDirectRun = process.argv[1] != null
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const html = await copyWebDistUntilMobileHtmlExists();
  await writeFile(path.join(MOBILE_DIST, 'index.html'), rewriteNativeViewport(html));
}
