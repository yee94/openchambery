/** Cap PROJECT_ICONS / PROJECT_COLORS keys (Expo owns glyph polish later). */
export const PROJECT_ICON_KEYS = [
  'code',
  'terminal',
  'rocket',
  'flask',
  'gamepad',
  'briefcase',
  'home',
  'globe',
  'leaf',
  'shield',
  'palette',
  'server',
  'phone',
  'database',
  'lightbulb',
  'music',
  'camera',
  'book',
  'heart',
] as const;

export type ProjectIconKey = (typeof PROJECT_ICON_KEYS)[number];

export const PROJECT_COLOR_KEYS = [
  'keyword',
  'string',
  'number',
  'type',
  'constant',
  'comment',
  'error',
  'primary',
  'success',
] as const;

export type ProjectColorKey = (typeof PROJECT_COLOR_KEYS)[number];

export const PROJECT_COLOR_HEX: Record<ProjectColorKey, string> = {
  keyword: '#a855f7',
  string: '#22c55e',
  number: '#ec4899',
  type: '#eab308',
  constant: '#06b6d4',
  comment: '#71717a',
  error: '#ef4444',
  primary: '#f97316',
  success: '#16a34a',
};

export const isProjectIconKey = (value: unknown): value is ProjectIconKey =>
  typeof value === 'string' && (PROJECT_ICON_KEYS as readonly string[]).includes(value);

export const isProjectColorKey = (value: unknown): value is ProjectColorKey =>
  typeof value === 'string' && (PROJECT_COLOR_KEYS as readonly string[]).includes(value);
