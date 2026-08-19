import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { bunTestShim, sharedExclude } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    name: 'openchamber-vscode',
    environment: 'node',
    isolate: true,
    exclude: sharedExclude,
  },
  resolve: {
    alias: {
      'bun:test': bunTestShim,
      vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
    },
  },
});
