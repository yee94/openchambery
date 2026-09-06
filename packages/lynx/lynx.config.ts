import { defineConfig } from '@lynx-js/rspeedy'
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin'

/**
 * Rspeedy config for the Lynx 3.8+ bundle.
 *
 * Do not upload this bundle to Capgo — Capgo is Capacitor web-bundle OTA only.
 *
 * Host notes:
 * - Mode A pages may use official <blur-view> glass attrs.
 * - Mode B pages are content-only; host UITabBar owns chrome.
 * - Chat list engine is LegendList 1.19 semantics when that track lands.
 */
export default defineConfig({
  source: {
    entry: './src/index.tsx',
  },
  plugins: [
    pluginReactLynx({
      // glass / glass-container require Lynx Engine >= 3.8
      engineVersion: '3.8',
    }),
  ],
})
