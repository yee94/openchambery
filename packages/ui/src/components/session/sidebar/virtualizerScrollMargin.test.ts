import { describe, expect, test } from 'vitest';
import { Virtualizer } from '@tanstack/react-virtual';

describe('virtualizer range clamp coordinates', () => {
  test.each([0, 400, 3600])('renders the last page with a %ipx ancestor offset', (scrollMargin) => {
    const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
      count: 52,
      getScrollElement: () => null,
      estimateSize: () => 36,
      scrollMargin,
      initialRect: { width: 260, height: 600 },
      initialOffset: scrollMargin + 52 * 36 - 600,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });

    expect(virtualizer.getVirtualItems().at(-1)?.index).toBe(51);
    expect(virtualizer.calculateRange()?.startIndex).toBe(35);
  });

  test('still fills the viewport during transient end-anchor overscroll', () => {
    const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
      count: 52,
      getScrollElement: () => null,
      estimateSize: () => 36,
      initialRect: { width: 260, height: 600 },
      initialOffset: 10000,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });

    expect(virtualizer.calculateRange()).toEqual({ startIndex: 35, endIndex: 51 });
  });

  test('keeps the last page rendered as Show more grows sibling and current groups', () => {
    const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
      count: 20,
      getScrollElement: () => null,
      estimateSize: () => 36,
      initialRect: { width: 260, height: 600 },
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });

    for (const count of [40, 60, 80, 100, 140, 200]) {
      const scrollMargin = count * 40;
      virtualizer.setOptions({ ...virtualizer.options, count, scrollMargin });
      virtualizer.scrollOffset = scrollMargin + count * 36 - 600;
      const items = virtualizer.getVirtualItems();
      expect(items.at(-1)?.index).toBe(count - 1);
      expect(items[0].start).toBeLessThanOrEqual(virtualizer.scrollOffset);
      expect(items.length).toBeLessThanOrEqual(20);
    }
  });
});
