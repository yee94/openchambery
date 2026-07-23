/**
 * Bundle main.mjs into a single file. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@openchamber/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 * Why external matters: packages/web/server pulls in bun-pty, which has
 * a top-level `import { dlopen } from "bun:ffi"`. If we inline it here,
 * Node's ESM loader sees `bun:ffi` at package load time and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before any runtime guard can skip it.
 * Leaving @openchamber/web external means the conditional
 * `if (isBunRuntime) await import('bun-pty')` stays dynamic and is never
 * reached under Electron.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const updaterE2eBuild = process.env.OPENCHAMBER_UPDATER_E2E_BUILD === '1';
// Bake packaging profile into main so packaged preview apps isolate userData
// without relying on process env at runtime. Default remains release for CI.
const desktopProfile = String(process.env.OPENCHAMBER_DESKTOP_PROFILE || 'release').trim().toLowerCase();
const desktopProfileDefine = (
  desktopProfile === 'preview' || desktopProfile === 'assistant-preview' || desktopProfile === 'assistant_preview'
)
  ? 'preview'
  : 'release';

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.mjs')],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
    'bun-pty',
    'node-pty',
    'better-sqlite3',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __OPENCHAMBER_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
    __OPENCHAMBER_DESKTOP_PROFILE__: JSON.stringify(desktopProfileDefine),
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log(`[electron] main.mjs bundled -> dist-bundle/main.mjs (profile=${desktopProfileDefine}, updater E2E=${updaterE2eBuild})`);
