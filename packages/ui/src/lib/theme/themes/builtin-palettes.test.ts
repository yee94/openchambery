import { describe, expect, test } from 'vitest';
import { isValidTheme } from '@/contexts/theme-validation';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { buildTextMateThemeFromAppTheme } from '@/lib/shiki/textMateThemeFromAppTheme';
import { getThemeById, themes } from '@/lib/theme/themes';

/** Matches OpenChamberVisualSettings formatThemeLabel: variant pickers strip the suffix. */
const selectorLabel = (name: string, variant: 'light' | 'dark'): string => {
  const suffix = variant === 'dark' ? ' Dark' : ' Light';
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

const registered = [
  {
    id: 'cursor-dark',
    variant: 'dark' as const,
    label: 'Cursor',
    primary: '#4c9df3',
    background: '#1a1a1a',
  },
  {
    id: 'cursor-light',
    variant: 'light' as const,
    label: 'Cursor',
    primary: '#2567A8',
    background: '#FCFCFC',
  },
  {
    id: 'osaka-jade-refined',
    variant: 'dark' as const,
    label: 'Osaka Jade Refined',
    primary: '#2DD5B7',
    background: '#111c18',
  },
  {
    id: 'osaka-jade-refined-light',
    variant: 'light' as const,
    label: 'Osaka Jade Refined',
    primary: '#206B5C',
    background: '#F6F5E9',
  },
];

describe('built-in Cursor and Osaka Jade palettes', () => {
  test('registers both variants so the selector can apply their colors', () => {
    const generator = new CSSVariableGenerator();

    for (const expected of registered) {
      const theme = getThemeById(expected.id);
      expect(theme, expected.id).toBeDefined();
      expect(theme?.metadata.variant).toBe(expected.variant);
      expect(selectorLabel(theme?.metadata.name ?? '', expected.variant)).toBe(expected.label);
      expect(isValidTheme(theme)).toBe(true);
      expect(theme?.colors.primary.base).toBe(expected.primary);
      expect(theme?.colors.surface.background).toBe(expected.background);

      const css = generator.generate(theme!);
      expect(css).toContain(`--primary-base: ${expected.primary};`);
      expect(css).toContain(`--background: ${expected.background} !important;`);
      expect(css).not.toContain('undefined');

      const highlight = buildTextMateThemeFromAppTheme(theme!);
      expect(highlight.type).toBe(expected.variant);
      expect(highlight.colors).toBeDefined();
      expect(highlight.colors?.['editor.background']).toBe(expected.background);
      expect(highlight.colors?.['button.background']).toBe(expected.primary);
    }
  });

  test('keeps previously registered themes and does not enable other commented palettes', () => {
    const ids = new Set(themes.map((theme) => theme.metadata.id));

    for (const id of [
      'carbonfox-light',
      'vitesse-dark-dark',
      'flexoki-dark',
      'flexoki-light',
      'dracula-dark',
      'openchamber-dark',
      'openchamber-light',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }

    for (const id of ['github-dark', 'github-light', 'amoled-dark', 'vercel-dark', 'zenburn-dark', 'rosepine-dark']) {
      expect(ids.has(id), id).toBe(false);
    }
  });
});
