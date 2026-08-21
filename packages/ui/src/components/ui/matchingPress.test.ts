import { describe, expect, test } from 'vitest';

import {
  consumeMatchingPress,
  markMatchingPress,
  markOverlayScrimPress,
  shouldCommitOverlayScrimDismiss,
} from './matchingPress';

describe('matchingPress', () => {
  test('accepts a click only after pointerdown on the same owner', () => {
    const owner = document.createElement('button');
    expect(consumeMatchingPress({ currentTarget: owner, detail: 1 })).toBe(false);
    markMatchingPress({ currentTarget: owner });
    expect(consumeMatchingPress({ currentTarget: owner, detail: 1 })).toBe(true);
    expect(consumeMatchingPress({ currentTarget: owner, detail: 1 })).toBe(false);
  });

  test('rejects a click retargeted onto a different owner', () => {
    const search = document.createElement('input');
    const row = document.createElement('button');
    markMatchingPress({ currentTarget: search });
    expect(consumeMatchingPress({ currentTarget: row, detail: 1 })).toBe(false);
  });

  test('allows keyboard activation on the focused owner', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    expect(consumeMatchingPress({ currentTarget: button, detail: 0 })).toBe(true);
    button.remove();
  });

  test('rejects keyboard-shaped clicks while focus is on another field', () => {
    const search = document.createElement('input');
    const row = document.createElement('button');
    document.body.append(search, row);
    search.focus();
    expect(consumeMatchingPress({ currentTarget: row, detail: 0 })).toBe(false);
    search.remove();
    row.remove();
  });

  test('scrim helpers ignore events that originated inside the surface', () => {
    const scrim = document.createElement('div');
    const surface = document.createElement('div');
    scrim.append(surface);
    markOverlayScrimPress({ currentTarget: scrim, target: surface });
    expect(shouldCommitOverlayScrimDismiss({ currentTarget: scrim, target: scrim, detail: 1 })).toBe(false);
    markOverlayScrimPress({ currentTarget: scrim, target: scrim });
    expect(shouldCommitOverlayScrimDismiss({ currentTarget: scrim, target: scrim, detail: 1 })).toBe(true);
  });
});
