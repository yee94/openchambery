import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep long-running workspace progress visible in AI-agent environments too.
    reporters: ['default'],
    // Vitest 4: projects replace the removed workspace file.
    projects: [
      'packages/ui',
      'packages/web',
      'packages/vscode',
      'packages/electron',
      'packages/mobile',
      'packages/relay-server',
      'deploy/update-service',
    ],
  },
});
