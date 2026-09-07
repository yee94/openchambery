import { describe, expect, test } from 'bun:test';

import {
  FOCUSED_SESSION_ROW_VIEWPORT_RATIO,
  getFocusedSessionRowScrollTop,
} from './scrollFocusedSessionRow';

describe('getFocusedSessionRowScrollTop', () => {
  test('places the row one-third down the viewport', () => {
    expect(FOCUSED_SESSION_ROW_VIEWPORT_RATIO).toBe(1 / 3);
    expect(getFocusedSessionRowScrollTop({
      containerScrollTop: 0,
      containerClientHeight: 300,
      containerScrollHeight: 1000,
      rowOffsetFromViewportTop: 200,
    })).toBe(100);
  });

  test('is a no-op when the row is already at one-third', () => {
    expect(getFocusedSessionRowScrollTop({
      containerScrollTop: 50,
      containerClientHeight: 300,
      containerScrollHeight: 1000,
      rowOffsetFromViewportTop: 100,
    })).toBe(50);
  });

  test('clamps to the top when there is not enough content above', () => {
    expect(getFocusedSessionRowScrollTop({
      containerScrollTop: 0,
      containerClientHeight: 300,
      containerScrollHeight: 1000,
      rowOffsetFromViewportTop: 20,
    })).toBe(0);
  });

  test('clamps to max scroll when the row is near the end', () => {
    expect(getFocusedSessionRowScrollTop({
      containerScrollTop: 0,
      containerClientHeight: 300,
      containerScrollHeight: 400,
      rowOffsetFromViewportTop: 500,
    })).toBe(100);
  });
});
