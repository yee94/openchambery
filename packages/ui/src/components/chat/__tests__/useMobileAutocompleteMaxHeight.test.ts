import { describe, expect, test } from 'bun:test';
import {
  computeMobileAutocompleteFixedBox,
  computeMobileAutocompleteMaxHeight,
  MOBILE_AUTOCOMPLETE_GAP_PX,
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

  test('caps a keyboard-raised composer with the visible column (native card.maxY)', () => {
    // Header floor 115, card top 386, card bottom 526 (keyboard up).
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 386,
      boundaryTop: 115,
      viewportHeight: 526,
    });
    // available = 263; viewport cap = 210.4 → 210 — first row stays on screen
    expect(next).toBe(Math.floor(526 * MOBILE_AUTOCOMPLETE_VIEWPORT_HEIGHT_RATIO));
    expect(next).toBeLessThan(263);
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

  test('never exceeds the chat-boundary budget even when below the soft min floor', () => {
    // Keyboard + floating header leave less room than the soft 120px floor.
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 140,
      boundaryTop: 100,
      viewportHeight: 200,
    });
    // available = 140 - 100 - 8 = 32; must not force MIN_HEIGHT and cover the header
    expect(next).toBe(32);
    expect(next).toBeLessThan(MOBILE_AUTOCOMPLETE_MIN_HEIGHT);
  });

  test('applies the soft min floor only when the boundary budget allows it', () => {
    // available = 250 - 100 - 8 = 142 ≥ 120; viewport cap tiny → still respect available
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 250,
      boundaryTop: 100,
      viewportHeight: 100,
    });
    // viewportCap = 40; available = 142 → soft min raises to 120, then min(available)=120
    expect(next).toBe(MOBILE_AUTOCOMPLETE_MIN_HEIGHT);
  });

  test('soft min cannot exceed available space when viewport cap is tiny', () => {
    // available = 90; viewportCap = 40 → capped at 40 (soft min does not apply: available < 120)
    const next = computeMobileAutocompleteMaxHeight({
      popupBottom: 198,
      boundaryTop: 100,
      viewportHeight: 100,
    });
    expect(next).toBe(40);
  });
});

describe('computeMobileAutocompleteFixedBox', () => {
  test('anchors the panel above the composer from the layout fixed bottom', () => {
    const box = computeMobileAutocompleteFixedBox({
      composerTop: 600,
      composerLeft: 16,
      composerWidth: 360,
      fixedContainingBottom: 800,
      visibleBottom: 800,
      boundaryTop: 100,
      viewportHeight: 700,
    });
    expect(box.left).toBe(16);
    expect(box.width).toBe(360);
    expect(box.bottom).toBe(800 - (600 - MOBILE_AUTOCOMPLETE_GAP_PX));
    expect(box.maxHeight).toBe(computeMobileAutocompleteMaxHeight({
      popupBottom: 600 - MOBILE_AUTOCOMPLETE_GAP_PX,
      boundaryTop: 100,
      viewportHeight: 700,
    }));
  });

  test('does not use the shrunk visual bottom for CSS bottom (Android IME)', () => {
    // Layout viewport still 800px tall; visual viewport shrinks to 500 above the IME.
    // Composer sits at y=400 (above the keyboard). Using visibleBottom for CSS
    // bottom would yield ~108 and park the panel under the keyboard.
    const box = computeMobileAutocompleteFixedBox({
      composerTop: 400,
      composerLeft: 12,
      composerWidth: 340,
      fixedContainingBottom: 800,
      visibleBottom: 500,
      boundaryTop: 96,
      viewportHeight: 500,
    });
    const popupBottom = 400 - MOBILE_AUTOCOMPLETE_GAP_PX;
    expect(box.bottom).toBe(800 - popupBottom);
    expect(box.bottom).toBeGreaterThan(800 - 500);
    expect(box.maxHeight).toBe(computeMobileAutocompleteMaxHeight({
      popupBottom,
      boundaryTop: 96,
      viewportHeight: 500,
    }));
  });

  test('clamps the anchor into the visible band when the composer is covered', () => {
    // Composer still at layout y=700 while the visible band ends at 500 (IME up,
    // lift not applied yet). Anchor to the visible bottom so the panel stays
    // selectable above the keyboard instead of bottom:0 under it.
    const box = computeMobileAutocompleteFixedBox({
      composerTop: 700,
      composerLeft: 12,
      composerWidth: 340,
      fixedContainingBottom: 800,
      visibleBottom: 500,
      boundaryTop: 96,
      viewportHeight: 500,
    });
    const popupBottom = 500 - MOBILE_AUTOCOMPLETE_GAP_PX;
    expect(box.bottom).toBe(800 - popupBottom);
    expect(box.maxHeight).toBe(computeMobileAutocompleteMaxHeight({
      popupBottom,
      boundaryTop: 96,
      viewportHeight: 500,
    }));
    expect(box.maxHeight).toBeGreaterThan(0);
  });
});
