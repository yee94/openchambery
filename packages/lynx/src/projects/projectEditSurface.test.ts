import { describe, expect, test } from 'vitest';

import {
  applyLynxWorktreeOrderPaths,
  lynxEditableWorktreeLabel,
  moveLynxWorktreeOrder,
  normalizeLynxWorktreeOrderPath,
} from './projectEditSurface';
import { LYNX_PROJECT_COLORS, LYNX_PROJECT_ICONS, lynxProjectColorHex, lynxProjectIconGlyph } from './projectMeta';

describe('Lynx project edit surface helpers', () => {
  test('moveLynxWorktreeOrder moves ↑/↓ without wrapping', () => {
    const items = [
      { path: '/a' },
      { path: '/b' },
      { path: '/c' },
    ];
    expect(moveLynxWorktreeOrder(items, '/b', 'up').map((entry) => entry.path)).toEqual(['/b', '/a', '/c']);
    expect(moveLynxWorktreeOrder(items, '/b', 'down').map((entry) => entry.path)).toEqual(['/a', '/c', '/b']);
    expect(moveLynxWorktreeOrder(items, '/a', 'up')).toBe(items);
    expect(moveLynxWorktreeOrder(items, '/c', 'down')).toBe(items);
  });

  test('applyLynxWorktreeOrderPaths prefers Cap ordered paths then appends rest', () => {
    const items = [
      { path: '/repo/main' },
      { path: '/repo/wt-b' },
      { path: '/repo/wt-a' },
    ];
    expect(applyLynxWorktreeOrderPaths(items, ['/repo/wt-a', '/repo/wt-b']).map((entry) => entry.path))
      .toEqual(['/repo/wt-a', '/repo/wt-b', '/repo/main']);
  });

  test('normalize + label helpers', () => {
    expect(normalizeLynxWorktreeOrderPath('/repo/wt/')).toBe('/repo/wt');
    expect(lynxEditableWorktreeLabel({ path: '/x', branch: 'feature' })).toBe('feature');
    expect(lynxEditableWorktreeLabel({ path: '/x', name: 'wt' })).toBe('wt');
  });

  test('Cap icon/color catalogs expose keys Cap persists', () => {
    expect(LYNX_PROJECT_ICONS.some((entry) => entry.key === 'code')).toBe(true);
    expect(LYNX_PROJECT_COLORS.some((entry) => entry.key === 'keyword')).toBe(true);
    expect(lynxProjectIconGlyph('rocket')).toBe('🚀');
    expect(lynxProjectColorHex('error')).toBe('#AF3029');
    expect(lynxProjectColorHex(null)).toBeNull();
  });
});
