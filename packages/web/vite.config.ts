import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';
import { themeStoragePlugin } from '../../vite-theme-plugin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const pwaDevEnabled = process.env.OPENCHAMBER_DISABLE_PWA_DEV !== '1';
const reactScanToggle = (process.env.VITE_ENABLE_REACT_SCAN ?? '').toLowerCase();
const enableReactScan = reactScanToggle === '1' || reactScanToggle === 'true' || reactScanToggle === 'on' || reactScanToggle === 'yes';

// Resolve vendor chunk names from node_modules package ids.
// Use the last node_modules segment so bun's .bun store (and pnpm) resolve to the real package.
function resolveVendorChunkName(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;

  const normalized = id.replace(/\\/g, '/');
  const match = normalized.split('node_modules/').pop();
  if (!match || match.startsWith('.bun/') || match.startsWith('.pnpm/')) return undefined;

  const segments = match.split('/');
  const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  if (!packageName || packageName.startsWith('.')) return undefined;

  if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
  if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

  if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk';
  if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
  if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';
  if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax';

  const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
  return `vendor-${sanitized}`;
}

const CLIENT_TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/').replace(/[?#].*$/, '');
}

function isNonClientSource(id: string): boolean {
  const normalized = normalizeModuleId(id);
  if (CLIENT_TEST_FILE_RE.test(normalized)) return true;
  // Node backend lives under the Vite root; it must not enter the browser graph.
  return normalized.includes('/packages/web/server/') || normalized.startsWith('server/');
}

const NON_CLIENT_SOURCE_FILTER = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^bun:test$)|(?:^server\/)|(?:\/packages\/web\/server\/)/;
const NON_CLIENT_LOAD_FILTER = /(?:\0virtual:(?:bun-test|non-client-source))|(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^server\/)|(?:\/packages\/web\/server\/)/;

// bundledDev shares the client graph with production entries, but Rolldown will
// still parse watched/aliased test and server files and then fail named imports
// from bun:test / Node builtins (`MISSING_EXPORT`). Replace those sources with
// empty modules before their imports are followed.
function omitNonClientSourcesPlugin() {
  return {
    name: 'omit-non-client-sources',
    enforce: 'pre' as const,
    resolveId: {
      filter: { id: NON_CLIENT_SOURCE_FILTER },
      handler(id: string) {
        if (id === 'bun:test') return '\0virtual:bun-test';
        if (isNonClientSource(id)) return '\0virtual:non-client-source';
        return undefined;
      },
    },
    load: {
      filter: { id: NON_CLIENT_LOAD_FILTER },
      handler(id: string) {
        if (id === '\0virtual:bun-test') {
          return [
            'export const describe = () => {};',
            'export const test = () => {};',
            'export const it = () => {};',
            'export const expect = () => {};',
            'export const mock = () => {};',
            'export const beforeEach = () => {};',
            'export const afterEach = () => {};',
            'export const beforeAll = () => {};',
            'export const afterAll = () => {};',
          ].join('\n');
        }
        if (id === '\0virtual:non-client-source' || isNonClientSource(id)) {
          return 'export {}';
        }
        return undefined;
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname, '.'),
  // Experimental Rolldown bundled dev: serve bundled chunks instead of per-module ESM.
  experimental: {
    bundledDev: true,
  },
  plugins: [
    omitNonClientSourcesPlugin(),
    react(),
    // React Compiler via Rolldown Babel preset (plugin-react v6 no longer embeds Babel).
    babel({
      presets: [reactCompilerPreset()],
    }),
    {
      name: 'inject-react-scan-script',
      transformIndexHtml() {
        if (!enableReactScan) {
          return;
        }
        return [
          {
            tag: 'script',
            attrs: {
              crossorigin: 'anonymous',
              src: '//unpkg.com/react-scan/dist/auto.global.js',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    themeStoragePlugin(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot}'],
        // iOS Safari/PWA is much more reliable with a classic (non-module) SW bundle.
        rollupFormat: 'iife',
        // We already keep a custom manifest in index.html
        injectionPoint: undefined,
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@opencode-ai/sdk/v2', replacement: path.resolve(__dirname, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js') },
      { find: '@openchamber/ui', replacement: path.resolve(__dirname, '../ui/src') },
      { find: '@web', replacement: path.resolve(__dirname, './src') },
      { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  optimizeDeps: {
    // Prebundle the heavy runtime graph up front so desktop/mobile dynamic
    // imports do not keep discovering new deps mid-session (which rewrites
    // browserHash and 504s open tabs with "Outdated Optimize Dep").
    include: [
      '@opencode-ai/sdk/v2',
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'zustand',
      'zustand/middleware',
      '@tanstack/react-query',
      '@reactuses/core',
    ],
    // Finish the static crawl before serving optimized deps to clients.
    holdUntilCrawlEnd: true,
  },
  server: {
    port: 5173,
    // Warm both entry graphs so the first navigation to either surface does
    // not trigger a late optimizeDeps rewrite under an open browser tab.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/mobile-main.tsx',
        './index.html',
        './mobile.html',
      ],
    },
    proxy: {
      '/auth': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
        miniChat: path.resolve(__dirname, 'mini-chat.html'),
      },
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        codeSplitting: {
          groups: [
            {
              name: resolveVendorChunkName,
            },
          ],
        },
        // Preserve warnings and errors in production while dropping renderer-only
        // diagnostic logs and their ordinary object payloads from shipped bundles.
        ...(command === 'build'
          ? {
              minify: {
                compress: {
                  treeshake: {
                    manualPureFunctions: [
                      'console.debug',
                      'console.info',
                      'console.log',
                      'console.trace',
                      'console.group',
                      'console.groupCollapsed',
                      'console.groupEnd',
                    ],
                  },
                },
              },
            }
          : {}),
      },
    },
  },
}));