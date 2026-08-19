import { defineConfig } from 'vitest/config';
import { sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/update-service',
    environment: 'node',
    isolate: true,
    include: ['test/**/*.test.mjs'],
    exclude: sharedExclude,
  },
});
