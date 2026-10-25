import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  composerAutocompleteRowClassName,
  composerAutocompleteSurfaceClassName,
} from './composerAutocompleteChrome';

const here = dirname(fileURLToPath(import.meta.url));
const mobileStyles = readFileSync(join(here, '../../styles/mobile.css'), 'utf8');
const layerSource = readFileSync(join(here, './ComposerAutocompleteLayer.tsx'), 'utf8');

describe('composerAutocompleteChrome', () => {
  test('mobile and desktop share the glass surface', () => {
    expect(composerAutocompleteSurfaceClassName(true)).toContain('yuri-mobile-overlay-surface');
    expect(composerAutocompleteSurfaceClassName(true)).toContain('yuri-mobile-overlay-surface--translucent');
    expect(composerAutocompleteSurfaceClassName(true)).toContain('yuri-composer-autocomplete-surface');
    expect(composerAutocompleteSurfaceClassName(true)).not.toContain('bottom-full');
    expect(composerAutocompleteSurfaceClassName(true)).not.toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).not.toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).toContain('yuri-mobile-overlay-surface');
  });

  test('mobile rows drop the persisted selected slab', () => {
    expect(composerAutocompleteRowClassName(true, true)).toBe('yuri-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(true, false)).toBe('yuri-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(false, true)).toContain('mx-1.5');
    expect(composerAutocompleteRowClassName(false, true)).toContain('_40%,transparent)');
    expect(composerAutocompleteRowClassName(false, false)).toContain('hover:bg-');
  });

  test('glass recipe uses shared tokens and momentary press fill', () => {
    const overlay = mobileStyles.match(/\.yuri-mobile-overlay-surface \{[\s\S]*?\n\}/)?.[0] ?? '';
    const catalog = mobileStyles.match(/\.yuri-composer-autocomplete-surface \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(overlay).toContain('backdrop-filter:');
    expect(catalog).toContain('color-mix(in srgb, var(--surface-elevated) 22%, transparent)');
    expect(catalog).not.toContain('var(--yuri-mobile-glass-fill)');
    expect(mobileStyles).toContain('.yuri-composer-autocomplete-row:active {');
    expect(mobileStyles).toContain('background: var(--yuri-mobile-press-fill)');
    expect(mobileStyles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*\.yuri-mobile-overlay-surface/,
    );
    expect(layerSource).toContain('createPortal');
    expect(layerSource).toContain('document.body');
    expect(layerSource).toContain('fixed inset-0');
  });
});
