import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sequential files plus per-file isolation keep auth/runtime mocks, env
    // stubs, and Express apps from leaking 401/400 failures across suites.
    fileParallelism: false,
    isolate: true,
    pool: 'forks',
  },
  resolve: {
    alias: {
      'bun:test': fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)),
      '@': fileURLToPath(new URL('../ui/src', import.meta.url)),
    },
  },
});
