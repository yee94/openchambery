/**
 * Cap `projectMeta` PROJECT_ICONS / PROJECT_COLORS keys for Lynx edit surface.
 * Portable glyphs + Flexoki-aligned hex (no Cap Icon sprite / react-dom).
 */

export type LynxProjectIconKey = string;
export type LynxProjectColorKey = string;

export type LynxProjectIconOption = {
  key: LynxProjectIconKey;
  label: string;
  /** Portable text glyph — Cap uses Icon names; Lynx has no sprite here. */
  glyph: string;
};

export type LynxProjectColorOption = {
  key: LynxProjectColorKey;
  label: string;
  /** Flexoki / Cap token fallback hex for swatch preview. */
  hex: string;
};

/** Cap PROJECT_ICONS keys (same order). */
export const LYNX_PROJECT_ICONS: LynxProjectIconOption[] = [
  { key: 'code', label: 'Code', glyph: '</>' },
  { key: 'terminal', label: 'Terminal', glyph: '>_' },
  { key: 'rocket', label: 'Rocket', glyph: '🚀' },
  { key: 'flask', label: 'Lab', glyph: '🧪' },
  { key: 'gamepad', label: 'Game', glyph: '🎮' },
  { key: 'briefcase', label: 'Work', glyph: '💼' },
  { key: 'home', label: 'Home', glyph: '🏠' },
  { key: 'globe', label: 'Web', glyph: '🌐' },
  { key: 'leaf', label: 'Nature', glyph: '🍃' },
  { key: 'shield', label: 'Security', glyph: '🛡' },
  { key: 'palette', label: 'Design', glyph: '🎨' },
  { key: 'server', label: 'Server', glyph: '🖥' },
  { key: 'phone', label: 'Mobile', glyph: '📱' },
  { key: 'database', label: 'Data', glyph: '🗄' },
  { key: 'lightbulb', label: 'Idea', glyph: '💡' },
  { key: 'music', label: 'Music', glyph: '🎵' },
  { key: 'camera', label: 'Media', glyph: '📷' },
  { key: 'book', label: 'Docs', glyph: '📖' },
  { key: 'heart', label: 'Favorite', glyph: '♥' },
];

/** Cap PROJECT_COLORS keys + Flexoki-light / status hex fallbacks. */
export const LYNX_PROJECT_COLORS: LynxProjectColorOption[] = [
  { key: 'keyword', label: 'Purple', hex: '#205EA6' },
  { key: 'string', label: 'Green', hex: '#24837B' },
  { key: 'number', label: 'Pink', hex: '#5E409D' },
  { key: 'type', label: 'Gold', hex: '#AD8301' },
  { key: 'constant', label: 'Cyan', hex: '#24837B' },
  { key: 'comment', label: 'Muted', hex: '#6F6E69' },
  { key: 'error', label: 'Red', hex: '#AF3029' },
  { key: 'primary', label: 'Blue', hex: '#BC5215' },
  { key: 'success', label: 'Green', hex: '#66800B' },
];

export const LYNX_PROJECT_ICON_MAP: Record<string, LynxProjectIconOption> = Object.fromEntries(
  LYNX_PROJECT_ICONS.map((entry) => [entry.key, entry]),
);

export const LYNX_PROJECT_COLOR_MAP: Record<string, LynxProjectColorOption> = Object.fromEntries(
  LYNX_PROJECT_COLORS.map((entry) => [entry.key, entry]),
);

export const lynxProjectIconGlyph = (icon: string | null | undefined): string => {
  if (!icon) return '📁';
  return LYNX_PROJECT_ICON_MAP[icon]?.glyph ?? '📁';
};

export const lynxProjectColorHex = (color: string | null | undefined): string | null => {
  if (!color) return null;
  return LYNX_PROJECT_COLOR_MAP[color]?.hex ?? null;
};
