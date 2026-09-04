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

describe('composerAutocompleteChrome', () => {
  test('mobile surface is glass; desktop keeps the bordered panel', () => {
    expect(composerAutocompleteSurfaceClassName(true)).toContain('oc-composer-autocomplete-surface');
    expect(composerAutocompleteSurfaceClassName(true)).not.toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).toContain('border-2');
    expect(composerAutocompleteSurfaceClassName(false)).not.toContain('oc-composer-autocomplete-surface');
  });

  test('mobile rows drop the persisted selected slab', () => {
    expect(composerAutocompleteRowClassName(true, true)).toBe('oc-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(true, false)).toBe('oc-composer-autocomplete-row');
    expect(composerAutocompleteRowClassName(false, true)).toBe('bg-interactive-selection');
    expect(composerAutocompleteRowClassName(false, false)).toBeUndefined();
  });

  test('glass recipe uses shared tokens and momentary press fill', () => {
    expect(mobileStyles).toContain('.oc-composer-autocomplete-surface {');
    expect(mobileStyles).toContain('background: var(--oc-mobile-glass-fill)');
    expect(mobileStyles).toContain('box-shadow: var(--oc-mobile-glass-shadow)');
    expect(mobileStyles).toContain('.oc-composer-autocomplete-row:active {');
    expect(mobileStyles).toContain('background: var(--oc-mobile-press-fill)');
    expect(mobileStyles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*\.oc-composer-autocomplete-surface/,
    );
  });
});
