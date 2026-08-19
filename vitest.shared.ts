import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';

export const bunTestShim = fileURLToPath(
  new URL('./scripts/test/bun-test-shim.ts', import.meta.url),
);

export const sharedExclude = [
  ...configDefaults.exclude,
  '**/dist/**',
  '**/dist-bundle/**',
  '**/ios/**',
  '**/android/**',
];
