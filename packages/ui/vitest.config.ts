import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/ui',
    environment: 'happy-dom',
    isolate: true,
    exclude: sharedExclude,
    setupFiles: [fileURLToPath(new URL('../../scripts/test/ui-setup.ts', import.meta.url))],
  },
  resolve: {
    alias: {
      'bun:test': bunTestShim,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
