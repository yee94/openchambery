import { describe, expect, test } from 'bun:test';
import {
  MOBILE_SEMANTIC_TYPOGRAPHY,
  SEMANTIC_TYPOGRAPHY,
  getSemanticTypographyBase,
  getTypographyVariable,
  usesMobileTypographyBase,
} from './typography';

describe('typography bases', () => {
  test('mobile body defaults to 15px (between former 16px and desktop 14px)', () => {
    expect(MOBILE_SEMANTIC_TYPOGRAPHY.markdown).toBe('0.9375rem');
    expect(parseFloat(MOBILE_SEMANTIC_TYPOGRAPHY.markdown)).toBeGreaterThan(
      parseFloat(SEMANTIC_TYPOGRAPHY.markdown),
    );
    expect(parseFloat(MOBILE_SEMANTIC_TYPOGRAPHY.markdown)).toBeLessThan(1);
  });

  test('getSemanticTypographyBase selects mobile vs desktop bases', () => {
    expect(getSemanticTypographyBase('markdown')).toBe(SEMANTIC_TYPOGRAPHY.markdown);
    expect(getSemanticTypographyBase('markdown', { mobile: true })).toBe(
      MOBILE_SEMANTIC_TYPOGRAPHY.markdown,
    );
    expect(getSemanticTypographyBase('code', { mobile: true })).toBe(
      MOBILE_SEMANTIC_TYPOGRAPHY.code,
    );
  });

  test('getTypographyVariable maps camelCase keys', () => {
    expect(getTypographyVariable('uiHeader')).toBe('--text-ui-header');
    expect(getTypographyVariable('markdown')).toBe('--text-markdown');
  });

  test('usesMobileTypographyBase requires mobile-pointer without desktop-runtime', () => {
    const makeRoot = (...classes: string[]) => {
      const classList = new Set(classes);
      return {
        classList: {
          contains: (name: string) => classList.has(name),
        },
      } as unknown as Element;
    };

    expect(usesMobileTypographyBase(makeRoot())).toBe(false);
    expect(usesMobileTypographyBase(makeRoot('mobile-pointer'))).toBe(true);
    expect(usesMobileTypographyBase(makeRoot('mobile-pointer', 'desktop-runtime'))).toBe(false);
  });

  test('percentage scale multiplies the active mobile base', () => {
    const base = parseFloat(getSemanticTypographyBase('markdown', { mobile: true }));
    const scaled = base * (90 / 100);
    expect(scaled).toBe(0.84375);
  });
});
