import { describe, expect, test } from 'bun:test';
import {
  computeMobileAutocompleteMaxHeight,
  MOBILE_AUTOCOMPLETE_MIN_HEIGHT,
  MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO,
} from '../useMobileAutocompleteMaxHeight';

describe('computeMobileAutocompleteMaxHeight', () => {
  test('caps long available space at 40% of the visual viewport', () => {
    // Composer near the bottom; chat boundary near the top → plenty of room.
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 800,
      boundaryTop: 56,
      viewportHeight: 900,
    });
    expect(next).toBe(Math.floor(900 * MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO));
  });

  test('uses the smaller chat-boundary budget when space is tighter than 40%', () => {
    // Keyboard open: only ~142px between composer and chat top.
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 250,
      boundaryTop: 100,
      viewportHeight: 900,
    });
    // available = 250 - 100 - 8 = 142; viewport cap = 360 → 142
    expect(next).toBe(142);
  });

  test('never drops below the minimum height floor', () => {
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 140,
      boundaryTop: 100,
      viewportHeight: 200,
    });
    expect(next).toBe(MOBILE_AUTOCOMPLETE_MIN_HEIGHT);
  });
});
