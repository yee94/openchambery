import { defineConfig } from 'vitest/config';

import { sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: '@yuri/mobile',
    environment: 'node',
    isolate: true,
    include: ['test/**/*.test.mjs'],
    exclude: sharedExclude,
  },
});
