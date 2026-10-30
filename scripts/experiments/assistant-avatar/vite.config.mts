import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../../packages/ui/src', import.meta.url)),
      '@reactuses/core': fileURLToPath(new URL('../../../packages/ui/node_modules/@reactuses/core/dist/index.mjs', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  build: { outDir: '../../../.scratch/assistant-avatar-lab-dist', emptyOutDir: true },
});
