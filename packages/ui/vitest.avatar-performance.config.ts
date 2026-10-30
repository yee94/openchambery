import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'avatar-performance',
    environment: 'node',
    include: ['src/lib/assistant-avatar/performance.chrome.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
