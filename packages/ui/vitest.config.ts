import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@yuriai/ui',
    environment: 'happy-dom',
    isolate: true,
    exclude: sharedExclude,
    setupFiles: [fileURLToPath(new URL('../../scripts/test/ui-setup.ts', import.meta.url))],
    // GUI SDK helpers and the host must share the browser Solid owner graph.
    server: { deps: { inline: ['solid-js', '@opencode/plugin'] } },
  },
  resolve: {
    conditions: ['browser'],
    alias: {
      'bun:test': bunTestShim,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
