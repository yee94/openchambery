import { describe, expect, it } from 'vitest';

import {
  parseBrowserProviderCatalog,
  parseBrowserProviderSelection,
  selectedBrowserProvider,
  shouldShowBrowserProviderRail,
  shouldShowBrowserProviderSettings,
} from './contract';

describe('browser provider catalog', () => {
  it('lists providers and keeps a selection only when it is listed', () => {
    const catalog = parseBrowserProviderCatalog({
      providers: [
        { id: 'ext.chrome', name: 'Chrome', surface: true },
        { id: 'bad id', name: 'Skipped', surface: true },
        { id: 'ext.chrome', name: 'Duplicate', surface: false },
      ],
      selectedId: 'ext.chrome',
    });

    expect(catalog).toEqual({
      providers: [{ id: 'ext.chrome', name: 'Chrome', surface: true }],
      selectedId: 'ext.chrome',
    });
    expect(shouldShowBrowserProviderSettings(catalog)).toBe(true);
    expect(selectedBrowserProvider(catalog)?.name).toBe('Chrome');
    expect(shouldShowBrowserProviderRail(catalog)).toBe(true);
  });

  it('does not treat an empty or dangling selection as a connected browser', () => {
    const empty = parseBrowserProviderCatalog({ providers: [], selectedId: 'builtin' });
    expect(empty).toEqual({ providers: [], selectedId: null });
    expect(shouldShowBrowserProviderSettings(empty)).toBe(false);
    expect(shouldShowBrowserProviderRail(empty)).toBe(false);

    const dangling = parseBrowserProviderCatalog({
      providers: [{ id: 'ext.chrome', name: 'Chrome', surface: true }],
      selectedId: 'missing',
    });
    expect(dangling?.selectedId).toBeNull();
    expect(shouldShowBrowserProviderRail(dangling)).toBe(false);
    expect(parseBrowserProviderCatalog(null)).toBeNull();
    expect(parseBrowserProviderCatalog({ providers: 'nope' })).toBeNull();
  });

  it('accepts a selection reply only when it names a provider id', () => {
    expect(parseBrowserProviderSelection({ selectedId: 'ext.chrome' })).toEqual({ selectedId: 'ext.chrome' });
    expect(parseBrowserProviderSelection({ selectedId: '' })).toBeNull();
    expect(parseBrowserProviderSelection({ ok: true })).toBeNull();
  });
});
