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
  test('mobile surface is glass; desktop keeps the bordered panel', () => {
    expect(composerAutocompleteSurfaceClassName(true)).toContain('oc-mobile-overlay-surface');
    expect(composerAutocompleteSurfaceClassName(true)).toContain('oc-mobile-overlay-surface--translucent');
    expect(composerAutocompleteSurfaceClassName(true)).not.toContain('bottom-full');
    expect(composerAutocompleteSurfaceClassName(true)).not.toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).not.toContain('oc-mobile-overlay-surface');
  });

  test('mobile rows drop the persisted selected slab', () => {
    expect(composerAutocompleteRowClassName(true, true)).toBe('oc-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(true, false)).toBe('oc-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(false, true)).toBe('bg-interactive-selection');
    expect(composerAutocompleteRowClassName(false, false)).toBeUndefined();
  });

  test('glass recipe uses shared tokens and momentary press fill', () => {
    const overlay = mobileStyles.match(/\.oc-mobile-overlay-surface \{[\s\S]*?\n\}/)?.[0] ?? '';
    const translucent = mobileStyles.match(/\.oc-mobile-overlay-surface--translucent \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(overlay).toContain('backdrop-filter:');
    expect(translucent).toContain('color-mix(in srgb, var(--surface-elevated) 48%, transparent)');
    expect(mobileStyles).toContain('.oc-composer-autocomplete-row:active {');
    expect(mobileStyles).toContain('background: var(--oc-mobile-press-fill)');
    expect(mobileStyles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*\.oc-mobile-overlay-surface/,
    );
    expect(layerSource).toContain('createPortal');
    expect(layerSource).toContain('oc-chat-composer-swap-scope');
    expect(layerSource).toContain('fixed inset-0');
  });
});
