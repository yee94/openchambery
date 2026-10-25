import { defineConfig } from 'vitest/config';

import { sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@yuriai/mobile',
    environment: 'node',
    isolate: true,
    include: ['test/**/*.test.mjs'],
    exclude: sharedExclude,
  },
});
