import { describe, expect, test } from 'vitest';

import {
  LYNX_LIGHT_FALLBACKS,
  LYNX_TOKEN_CSS_VARS,
  cssVar,
  type LynxSemanticToken,
} from './tokens';

describe('Lynx semantic tokens', () => {
  test('exposes Cap status success/error for portable diff add/del', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.success']).toBe('--status-success');
    expect(LYNX_TOKEN_CSS_VARS['status.error']).toBe('--status-error');
    expect(cssVar('status.success')).toBe('var(--status-success, #66800B)');
    expect(cssVar('status.error')).toBe('var(--status-error, #AF3029)');
  });

  test('exposes Cap on-error (destructive-foreground) for solid error fills', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.onError']).toBe('--destructive-foreground');
    expect(cssVar('status.onError')).toBe('var(--destructive-foreground, #fffdf4)');
  });

  test('every semantic token maps to a Cap CSS var with Flexoki-light fallback', () => {
    const keys = Object.keys(LYNX_TOKEN_CSS_VARS) as LynxSemanticToken[];
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const key of keys) {
      expect(LYNX_TOKEN_CSS_VARS[key].startsWith('--')).toBe(true);
      expect(LYNX_LIGHT_FALLBACKS[key]).toMatch(/^#/);
      expect(cssVar(key)).toBe(`var(${LYNX_TOKEN_CSS_VARS[key]}, ${LYNX_LIGHT_FALLBACKS[key]})`);
      expect(cssVar(key, null)).toBe(`var(${LYNX_TOKEN_CSS_VARS[key]})`);
    }
  });

  test('surface first-paint fallbacks are Flexoki-light cream + dark ink', () => {
    expect(LYNX_LIGHT_FALLBACKS['surface.background']).toBe('#fffdf4');
    expect(LYNX_LIGHT_FALLBACKS['surface.foreground']).toBe('#100F0F');
  });
});
