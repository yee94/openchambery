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
  | 'status.error';

/**
 * CSS-variable names the Lynx page should consume. Values come from the
 * Flexoki / Cap theme CSS vars in `@openchamber/ui` — do not invent a Lynx palette.
 * `status.success` / `status.error` are Cap ChangeRow A/D + portable diff add/del colors.
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
};

export function themeVariantForId(themeId: LynxThemeId): 'light' | 'dark' {
  return themeId === LYNX_DEFAULT_THEME_IDS.dark ? 'dark' : 'light';
}

export function cssVar(token: LynxSemanticToken): string {
  return `var(${LYNX_TOKEN_CSS_VARS[token]})`;
}
