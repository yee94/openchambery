import { defineConfig } from 'vitest/config';
import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';
export default defineConfig({
  test: {
    name: '@openchamber/relay-server',
    environment: 'node',
    isolate: true,
    fileParallelism: false,
    testTimeout: 30_000,
    include: ['test/**/*.test.js'],
    exclude: sharedExclude,
  },
  resolve: { alias: { 'bun:test': bunTestShim } },
});
