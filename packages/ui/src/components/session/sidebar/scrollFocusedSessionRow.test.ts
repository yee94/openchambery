import { describe, expect, test, vi } from 'vitest';

import {
  FOCUSED_SESSION_ROW_VIEWPORT_RATIO,
  getFocusedSessionRowScrollTop,
  scrollFocusedSessionRowIntoView,
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

describe('scrollFocusedSessionRowIntoView', () => {
  test.each([
    { top: 102, bottom: 132, expectedTop: null },
    { top: 250, bottom: 280, expectedTop: null },
    { top: 372, bottom: 402, expectedTop: null },
    { top: 90, bottom: 120, expectedTop: 88 },
    { top: 390, bottom: 420, expectedTop: 388 },
    { top: 50, bottom: 80, expectedTop: 48 },
    { top: 450, bottom: 480, expectedTop: 448 },
  ])('reveals row $top–$bottom only when clipped', ({ top, bottom, expectedTop }) => {
    const container = document.createElement('div');
    container.className = 'overlay-scrollbar-target';
    const row = document.createElement('div');
    container.append(row);
    container.scrollTop = 200;
    Object.defineProperties(container, {
      clientTop: { value: 2 },
      clientHeight: { value: 300 },
      scrollHeight: { value: 1000 },
    });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top, bottom } as DOMRect);
    const scrollTo = vi.spyOn(container, 'scrollTo').mockImplementation(() => {});

    scrollFocusedSessionRowIntoView(row, { behavior: 'auto' });

    if (expectedTop === null) {
      expect(scrollTo).not.toHaveBeenCalled();
      expect(container.scrollTop).toBe(200);
    } else {
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: expectedTop, behavior: 'auto' });
    }
    vi.restoreAllMocks();
  });
});
