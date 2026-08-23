import { beforeEach, describe, expect, test } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';

const root = () => document.documentElement;

const setMobileSurface = () => {
  root().classList.add('mobile-pointer');
  root().classList.remove('desktop-runtime');
};

const setDesktopSurface = () => {
  root().classList.remove('mobile-pointer');
  root().classList.add('desktop-runtime');
};

describe('applyTypography design-pt stacking', () => {
  beforeEach(() => {
    setMobileSurface();
    useUIStore.setState({ fontSize: 100, codeFontSize: 100 });
    root().style.removeProperty('--text-markdown');
    root().style.removeProperty('--text-code');
  });

  test('mobile user font scale rides var(--dpt) so settings stack with the physical scale', () => {
    useUIStore.setState({ fontSize: 110, codeFontSize: 100 });
    useUIStore.getState().applyTypography();

    // MOBILE_SEMANTIC_TYPOGRAPHY.markdown = 0.9375rem -> 15px * 1.1 = 16.5
    expect(root().style.getPropertyValue('--text-markdown')).toBe('calc(16.5 * var(--dpt))');
  });

  test('mobile code font scale also rides var(--dpt)', () => {
    useUIStore.setState({ fontSize: 100, codeFontSize: 120 });
    useUIStore.getState().applyTypography();

    // MOBILE_SEMANTIC_TYPOGRAPHY.code = 0.8125rem -> 13px * 1.2 = 15.6
    expect(root().style.getPropertyValue('--text-code')).toBe('calc(15.6 * var(--dpt))');
  });

  test('desktop overrides stay plain rem (no --dpt on desktop surfaces)', () => {
    setDesktopSurface();
    useUIStore.setState({ fontSize: 110, codeFontSize: 100 });
    useUIStore.getState().applyTypography();

    // SEMANTIC_TYPOGRAPHY.markdown = 0.875rem * 1.1
    const value = root().style.getPropertyValue('--text-markdown');
    expect(value.endsWith('rem')).toBe(true);
    expect(value).not.toContain('var(--dpt)');
    expect(Number.parseFloat(value)).toBeCloseTo(0.9625, 6);
  });

  test('100% removes inline overrides so stylesheet calc defaults apply', () => {
    useUIStore.setState({ fontSize: 130, codeFontSize: 100 });
    useUIStore.getState().applyTypography();
    expect(root().style.getPropertyValue('--text-markdown')).not.toBe('');

    useUIStore.setState({ fontSize: 100, codeFontSize: 100 });
    useUIStore.getState().applyTypography();
    expect(root().style.getPropertyValue('--text-markdown')).toBe('');
  });

  test('applyPadding writes the user value name so svg icons can stack --dpt', () => {
    useUIStore.setState({ padding: 144 });
    useUIStore.getState().applyPadding();
    // 1.44 → sqrt damping ≈ 1.2
    expect(Number.parseFloat(root().style.getPropertyValue('--user-padding-scale'))).toBeCloseTo(1.2, 5);
    expect(root().style.getPropertyValue('--padding-scale')).toBe('');

    useUIStore.setState({ padding: 100 });
    useUIStore.getState().applyPadding();
    expect(root().style.getPropertyValue('--user-padding-scale')).toBe('');
  });
});
