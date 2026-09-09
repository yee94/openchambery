import { describe, expect, test } from 'vitest';

import {
  LYNX_LIGHT_FALLBACKS,
  LYNX_TOKEN_CSS_VARS,
  cssVar,
  tokenColor,
  type LynxSemanticToken,
} from './tokens';

describe('Lynx semantic tokens', () => {
  test('exposes Cap status success/error for portable diff add/del', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.success']).toBe('--status-success');
    expect(LYNX_TOKEN_CSS_VARS['status.error']).toBe('--status-error');
    expect(cssVar('status.success')).toBe('#66800B');
    expect(cssVar('status.error')).toBe('#AF3029');
  });

  test('exposes Cap on-error (destructive-foreground) for solid error fills', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.onError']).toBe('--destructive-foreground');
    expect(cssVar('status.onError')).toBe('#fffdf4');
  });

  test('every semantic token maps to a Cap CSS var name and resolves to Flexoki-light hex', () => {
    const keys = Object.keys(LYNX_TOKEN_CSS_VARS) as LynxSemanticToken[];
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const key of keys) {
      expect(LYNX_TOKEN_CSS_VARS[key].startsWith('--')).toBe(true);
      expect(LYNX_LIGHT_FALLBACKS[key]).toMatch(/^#/);
      // Android Lynx drops inline style values containing var(...) — never emit var().
      expect(cssVar(key)).toBe(LYNX_LIGHT_FALLBACKS[key]);
      expect(cssVar(key)).not.toMatch(/var\(/);
      expect(cssVar(key, null)).toBe(LYNX_LIGHT_FALLBACKS[key]);
      expect(tokenColor(key)).toBe(cssVar(key));
    }
  });

  test('surface first-paint fallbacks are Flexoki-light cream + dark ink', () => {
    expect(LYNX_LIGHT_FALLBACKS['surface.background']).toBe('#fffdf4');
    expect(LYNX_LIGHT_FALLBACKS['surface.foreground']).toBe('#100F0F');
    expect(cssVar('surface.elevated')).toBe('#fbfaf2');
    expect(cssVar('primary.base')).toBe('#BC5215');
  });

  test('explicit fallback override still returns plain hex', () => {
    expect(cssVar('primary.base', '#ff0000')).toBe('#ff0000');
    expect(tokenColor('primary.base', '#00ff00')).toBe('#00ff00');
  });
});
