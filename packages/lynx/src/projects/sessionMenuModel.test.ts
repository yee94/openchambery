import { describe, expect, test, vi } from 'vitest';

import { buildLynxSessionMenuItems } from './sessionMenuModel';

describe('buildLynxSessionMenuItems', () => {
  test('matches Cap order: pin/archive/delete; callbacks gate visibility', () => {
    const items = buildLynxSessionMenuItems({
      pinned: true,
      shared: false,
      onTogglePin: vi.fn(),
      onShare: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(items.map((item) => item.id)).toEqual(['pin', 'share', 'archive', 'delete']);
    expect(items.find((item) => item.id === 'pin')?.labelKey).toBe('lynx.projects.menu.unpin');
    expect(items.find((item) => item.id === 'delete')?.destructive).toBe(true);
  });

  test('shared sessions expose copy/unshare instead of share', () => {
    const items = buildLynxSessionMenuItems({
      pinned: false,
      shared: true,
      onCopyLink: vi.fn(),
      onUnshare: vi.fn(),
      onArchive: vi.fn(),
    });
    expect(items.map((item) => item.id)).toEqual(['copyLink', 'unshare', 'archive']);
  });
});
