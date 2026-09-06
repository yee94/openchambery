import { describe, expect, it } from 'vitest';

import {
  composeCollapsedPillHeight,
  nextRestOccupancyHeight,
  resolveComposerOccupancyHeight,
} from '../composerOccupancy';

describe('composeCollapsedPillHeight', () => {
  it('adds chrome padding to native collapsed line height', () => {
    expect(
      composeCollapsedPillHeight({
        collapsedLineHeight: 40,
        pillVerticalPadding: 12,
      }),
    ).toBe(52);
  });
});

describe('resolveComposerOccupancyHeight', () => {
  it('returns collapsed pill only', () => {
    expect(
      resolveComposerOccupancyHeight({
        collapsedPillHeight: 52,
        contentHeight: 120,
        autocompleteOpen: true,
        scrollToBottomVisible: true,
      }),
    ).toBe(52);
  });

  it('freezes lastRestHeight while expanded', () => {
    expect(
      resolveComposerOccupancyHeight({
        collapsedPillHeight: 52,
        contentHeight: 140,
        expanded: true,
        lastRestHeight: 52,
        autocompleteOpen: true,
      }),
    ).toBe(52);
  });

  it('ignores content growth when not expanded', () => {
    expect(
      resolveComposerOccupancyHeight({
        collapsedPillHeight: 48,
        contentHeight: 200,
        expanded: false,
      }),
    ).toBe(48);
  });
});

describe('nextRestOccupancyHeight', () => {
  it('updates while collapsed', () => {
    expect(nextRestOccupancyHeight(52, false, 40)).toBe(52);
  });

  it('keeps last rest while expanded', () => {
    expect(nextRestOccupancyHeight(80, true, 52)).toBe(52);
  });
});
