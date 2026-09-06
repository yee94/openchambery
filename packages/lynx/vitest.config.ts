import { defineConfig } from 'vitest/config';

import { sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@openchamber/lynx',
    environment: 'node',
    isolate: true,
    include: ['src/**/*.test.ts'],
    exclude: sharedExclude,
  },
});
