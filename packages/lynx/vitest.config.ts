import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/lynx',
    environment: 'node',
    isolate: true,
    include: ['src/**/*.test.ts'],
    exclude: sharedExclude,
  },
  resolve: {
    alias: {
      'bun:test': bunTestShim,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
