import { describe, expect, test } from 'vitest';

import { LYNX_TOKEN_CSS_VARS, cssVar, type LynxSemanticToken } from './tokens';

describe('Lynx semantic tokens', () => {
  test('exposes Cap status success/error for portable diff add/del', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.success']).toBe('--status-success');
    expect(LYNX_TOKEN_CSS_VARS['status.error']).toBe('--status-error');
    expect(cssVar('status.success')).toBe('var(--status-success)');
    expect(cssVar('status.error')).toBe('var(--status-error)');
  });

  test('exposes Cap on-error (destructive-foreground) for solid error fills', () => {
    expect(LYNX_TOKEN_CSS_VARS['status.onError']).toBe('--destructive-foreground');
    expect(cssVar('status.onError')).toBe('var(--destructive-foreground)');
  });

  test('every semantic token maps to a Cap CSS var', () => {
    const keys = Object.keys(LYNX_TOKEN_CSS_VARS) as LynxSemanticToken[];
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const key of keys) {
      expect(LYNX_TOKEN_CSS_VARS[key].startsWith('--')).toBe(true);
      expect(cssVar(key)).toBe(`var(${LYNX_TOKEN_CSS_VARS[key]})`);
    }
  });
});
