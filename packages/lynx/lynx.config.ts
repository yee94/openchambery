/**
 * Intended Rspeedy config for the Lynx 3.8+ bundle.
 *
 * This file is not typechecked in the scaffold (see `tsconfig.json` include).
 * When the bundle job lands, add:
 *   @lynx-js/rspeedy
 *   @lynx-js/react
 *   @lynx-js/react-rsbuild-plugin
 * and set `engineVersion` to at least `3.8` so `glass` / `glass-container` exist.
 *
 * Do not upload this bundle to Capgo — Capgo is Capacitor web-bundle OTA only.
 */
export const lynxScaffoldBundler = {
  source: { entry: 'src/index.tsx' },
  engineVersion: '3.8',
  notes: [
    'Mode A pages may use official <blur-view> glass attrs.',
    'Mode B pages are content-only; host UITabBar owns chrome.',
    'Chat list engine is LegendList 1.19 semantics when that track lands.',
  ],
} as const;
