/**
 * Cap design-system OKLCH → sRGB (packages/ui/src/styles/design-system.css).
 * README/Cap screenshots may show UIKit blue — do NOT recolor to that.
 * Official --primary stays orange / golden sand (docs/expo-ia-ui.md).
 */
const tintColorLight = '#e66200'; // oklch(0.65 0.2 55)
const tintColorDark = '#edb449'; // oklch(0.77 0.17 85) Cap comment

export default {
  light: {
    text: '#2a1e1a', // oklch(0.25 0.02 40)
    background: '#fbf4e6', // oklch(0.97 0.02 85) warm sand
    tint: tintColorLight,
    primaryForeground: '#fefcf4',
    tabIconDefault: '#5f524c',
    tabIconSelected: tintColorLight,
    muted: '#5f524c', // muted-foreground
    card: '#fefcf4', // oklch(0.99 0.01 90)
    elevated: '#f7f0e4',
    border: '#d7ccc0',
    secondary: '#ece3d6',
    destructive: '#c23b2e',
    fade: 'rgba(251,244,230,0.92)',
    glassFill: 'rgba(255,255,255,0.68)',
  },
  dark: {
    text: '#cdccc3', // Cap comment
    background: '#151313', // Cap comment oklch(0.16 0.01 30)
    tint: tintColorDark,
    primaryForeground: '#151313',
    tabIconDefault: '#b6b4ab',
    tabIconSelected: tintColorDark,
    muted: '#b6b4ab',
    card: '#1c1b1a', // Cap comment
    elevated: '#282726',
    border: '#393836',
    secondary: '#343331',
    destructive: '#d98678',
    fade: 'rgba(21,19,19,0.92)',
    glassFill: 'rgba(38,38,44,0.66)',
  },
};
