import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeStoragePlugin } from './vite-theme-plugin.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve vendor chunk names from node_modules package ids.
// Use the last node_modules segment so bun's .bun store (and pnpm) resolve to the real package.
function resolveVendorChunkName(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  const normalized = id.replace(/\\/g, '/')
  const match = normalized.split('node_modules/').pop()
  if (!match || match.startsWith('.bun/') || match.startsWith('.pnpm/')) return undefined

  const segments = match.split('/')
  const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
  if (!packageName || packageName.startsWith('.')) return undefined

  if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react'
  if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand'
  if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk'
  if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown'
  if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui'
  if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax'

  const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-')
  return `vendor-${sanitized}`
}

export default defineConfig({
  plugins: [
    react(),
    themeStoragePlugin(),
  ],
  resolve: {
    alias: [
      { find: '@opencode-ai/sdk/v2', replacement: path.resolve(__dirname, './node_modules/@opencode-ai/sdk/dist/v2/client.js') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['@opencode-ai/sdk/v2'],
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        codeSplitting: {
          groups: [
            {
              name: resolveVendorChunkName,
            },
          ],
        },
      },
    },
  },
})