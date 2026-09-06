import { describe, expect, it } from 'vitest';

import {
  EXPO_SETTINGS_PAGE_SLUGS,
  getSettingsPageMeta,
  groupSettingsPages,
  resolveExpoSettingsSlug,
} from '@/lib/settings/metadata';
import { buildSettingsHomeGroups, searchSettingsPages } from '@/lib/settings/settingsHomeModel';

describe('settings metadata', () => {
  it('omits voice from Expo mobile slugs', () => {
    expect(EXPO_SETTINGS_PAGE_SLUGS).not.toContain('voice' as never);
    expect(EXPO_SETTINGS_PAGE_SLUGS).toContain('instances');
    expect(EXPO_SETTINGS_PAGE_SLUGS).toContain('assistants');
    expect(EXPO_SETTINGS_PAGE_SLUGS).toContain('about');
  });

  it('groups pages in Cap order', () => {
    const groups = groupSettingsPages();
    expect(groups[0]?.group).toBe('connection');
    expect(groups[0]?.pages[0]?.slug).toBe('instances');
    expect(groups.every((g) => g.pages.every((p) => (p.slug as string) !== 'voice'))).toBe(true);
  });

  it('resolves voice back to home', () => {
    expect(resolveExpoSettingsSlug('voice')).toBe('home');
    expect(resolveExpoSettingsSlug('assistants')).toBe('assistants');
    expect(getSettingsPageMeta('providers')?.kind).toBe('split');
  });

  it('searches by title keywords', () => {
    const hits = searchSettingsPages('provider models', {
      translate: (key) => key,
    });
    expect(hits.some((h) => h.slug === 'providers')).toBe(true);
    expect(buildSettingsHomeGroups().length).toBeGreaterThan(3);
  });
});
