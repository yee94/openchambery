import { describe, expect, test } from 'vitest';

import {
  computeLynxAutocompleteMaxHeight,
  LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT,
  LYNX_COMPOSER_AUTOCOMPLETE_WIRING_NOTES,
} from './composerAutocompleteLayout';
import { LYNX_COMPOSER_AUTOCOMPLETE_ABOVE_GLASS } from './imeOccupancy';

describe('composer autocomplete above glass', () => {
  test('placement forbids glass contentView', () => {
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.placement).toBe('above-glass-composer');
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.forbidInsideGlassContentView).toBe(true);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.countsAsOccupancy).toBe(false);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_ABOVE_GLASS).toBe(true);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_WIRING_NOTES[0]).toContain('ABOVE glass');
  });

  test('max height clamps Cap-style', () => {
    expect(computeLynxAutocompleteMaxHeight({
      spaceBelowHeader: 400,
      visibleColumnHeight: 500,
    })).toBe(200);
    expect(computeLynxAutocompleteMaxHeight({
      spaceBelowHeader: 100,
      visibleColumnHeight: 500,
    })).toBe(100);
  });
});
