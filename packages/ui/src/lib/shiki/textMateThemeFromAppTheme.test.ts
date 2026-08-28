import { describe, expect, test } from 'vitest';
import { buildTextMateThemeFromAppTheme } from './textMateThemeFromAppTheme';
import { getDefaultTheme } from '@/lib/theme/themes';

describe('buildTextMateThemeFromAppTheme token colors', () => {
  test('covers the constant.language family (undefined/null/NaN/Infinity)', () => {
    const theme = buildTextMateThemeFromAppTheme(getDefaultTheme(false));
    const rule = theme.tokenColors?.find((entry) => entry.scope?.includes('constant.language'));
    expect(rule).toBeDefined();
    expect(rule?.settings.foreground).toBeTruthy();
  });

  test('keeps parent-scope fallbacks for TS entity types', () => {
    const theme = buildTextMateThemeFromAppTheme(getDefaultTheme(true));
    // Generic type parameters (`entity.name.type.parameter`) fall back to the
    // broader `entity.name.type` rule — both must resolve to a color.
    const parentRule = theme.tokenColors?.find((entry) => entry.scope?.includes('entity.name.type'));
    expect(parentRule?.settings.foreground).toBeTruthy();
  });
});
