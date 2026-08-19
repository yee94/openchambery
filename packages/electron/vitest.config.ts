import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/electron',
    environment: 'node',
    isolate: true,
    exclude: sharedExclude,
  },
  resolve: {
    alias: {
      'bun:test': bunTestShim,
    },
  },
});
