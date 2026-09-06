/**
 * Semantic tokens only. Flexoki is the default **theme id** pair from Cap/web,
 * not a separate Lynx product.
 */
export const LYNX_DEFAULT_THEME_IDS = {
  light: 'flexoki-light',
  dark: 'flexoki-dark',
} as const;

export type LynxThemeId = typeof LYNX_DEFAULT_THEME_IDS[keyof typeof LYNX_DEFAULT_THEME_IDS];

export type LynxSemanticToken =
  | 'surface.background'
  | 'surface.foreground'
  | 'surface.muted'
  | 'surface.mutedForeground'
  | 'surface.elevated'
  | 'interactive.selection'
  | 'interactive.selectionForeground'
  | 'primary.base'
  | 'primary.foreground'
  /** Cap ChangeRow / portable diff — green additions (`--status-success`). */
  | 'status.success'
  /** Cap ChangeRow / portable diff — red deletions (`--status-error`). */
  | 'status.error'
  /** Cap text on solid error / destructive fill (`--destructive-foreground`). */
  | 'status.onError';

/**
 * CSS-variable names the Lynx page should consume. Values come from the
 * Flexoki / Cap theme CSS vars in `@openchamber/ui` — do not invent a Lynx palette.
 * `status.success` / `status.error` are Cap ChangeRow A/D + portable diff add/del colors.
 * `status.onError` is Cap `--destructive-foreground` for text on solid error fills (never hardcode `#fff`).
 */
export const LYNX_TOKEN_CSS_VARS: Record<LynxSemanticToken, string> = {
  'surface.background': '--surface-background',
  'surface.foreground': '--surface-foreground',
  'surface.muted': '--surface-muted',
  'surface.mutedForeground': '--surface-muted-foreground',
  'surface.elevated': '--surface-elevated',
  'interactive.selection': '--interactive-selection',
  'interactive.selectionForeground': '--interactive-selection-foreground',
  'primary.base': '--primary',
  'primary.foreground': '--primary-foreground',
  'status.success': '--status-success',
  'status.error': '--status-error',
  'status.onError': '--destructive-foreground',
};

export function themeVariantForId(themeId: LynxThemeId): 'light' | 'dark' {
  return themeId === LYNX_DEFAULT_THEME_IDS.dark ? 'dark' : 'light';
}

/**
 * Flexoki-light hex fallbacks for first paint when Cap CSS vars are not injected
 * into the Lynx page (native sideload). Prefer `cssVar(token)` which embeds these
 * as `var(--name, fallback)` so unresolved vars never go transparent/invisible.
 */
export const LYNX_LIGHT_FALLBACKS: Record<LynxSemanticToken, string> = {
  'surface.background': '#fffdf4',
  'surface.foreground': '#100F0F',
  'surface.muted': '#f6f5ee',
  'surface.mutedForeground': '#686663',
  'surface.elevated': '#fbfaf2',
  'interactive.selection': '#76736f30',
  'interactive.selectionForeground': '#100F0F',
  'primary.base': '#BC5215',
  'primary.foreground': '#fffdf4',
  'status.success': '#66800B',
  'status.error': '#AF3029',
  'status.onError': '#fffdf4',
};

/**
 * CSS var with Flexoki-light fallback. Pass `fallback: null` to emit bare
 * `var(--name)` (tests / callers that intentionally omit fallbacks).
 */
export function cssVar(token: LynxSemanticToken, fallback: string | null = LYNX_LIGHT_FALLBACKS[token]): string {
  const name = LYNX_TOKEN_CSS_VARS[token];
  if (fallback == null) return `var(${name})`;
  return `var(${name}, ${fallback})`;
}
