import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/web',
    // Sequential files plus per-file isolation keep auth/runtime mocks, env
    // stubs, and Express apps from leaking 401/400 failures across suites.
    fileParallelism: false,
    isolate: true,
    pool: 'forks',
    exclude: sharedExclude,
  },
  resolve: {
    alias: {
      'bun:test': bunTestShim,
      '@': fileURLToPath(new URL('../ui/src', import.meta.url)),
    },
  },
});
