import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { LYNX_MOBILE_SETTINGS_PAGE_SLUGS } from './slugs';
import {
  filterLynxSettingsPages,
  getLynxSettingsPageMeta,
  groupLynxSettingsPages,
  LYNX_FORBIDDEN_SETTINGS_TOGGLES,
  LYNX_SETTINGS_PAGE_GROUP_ORDER,
  LYNX_SETTINGS_PAGE_METADATA,
} from './metadata';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Lynx settings metadata', () => {
  test('metadata covers exactly the 22 Cap main mobile slugs in Cap order', () => {
    expect(LYNX_SETTINGS_PAGE_METADATA).toHaveLength(22);
    expect(LYNX_SETTINGS_PAGE_METADATA.map((page) => page.slug)).toEqual([
      ...LYNX_MOBILE_SETTINGS_PAGE_SLUGS,
    ]);
    expect(LYNX_SETTINGS_PAGE_GROUP_ORDER[0]).toBe('connection');
    expect(getLynxSettingsPageMeta('voice')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('appearance')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('providers')?.body).toBe('list');
    expect(getLynxSettingsPageMeta('about')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('behavior')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('summary-ai')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('archived-sessions')?.body).toBe('wired');
    expect(getLynxSettingsPageMeta('archived-sessions')?.title).toBe('Archived sessions');
    expect(getLynxSettingsPageMeta('archived-sessions')?.group).toBe('personalization');
    expect(getLynxSettingsPageMeta('archived-sessions')?.keywords).toEqual([
      'archive',
      'archived',
      'restore',
      'preview',
      'history',
    ]);
    expect(LYNX_FORBIDDEN_SETTINGS_TOGGLES).toContain('iosNativeUi');
  });

  test('groups connection first and search filters by title/keywords/slug', () => {
    const groups = groupLynxSettingsPages();
    expect(groups[0]?.group).toBe('connection');
    expect(groups[0]?.pages.map((p) => p.slug)).toEqual(['instances']);
    const personalization = groups.find((group) => group.group === 'personalization');
    expect(personalization?.pages.map((p) => p.slug)).toEqual([
      'appearance',
      'chat',
      'notifications',
      'sessions',
      'archived-sessions',
      'summary-ai',
    ]);
    expect(filterLynxSettingsPages('theme').map((p) => p.slug)).toContain('appearance');
    expect(filterLynxSettingsPages('archive').map((p) => p.slug)).toContain('archived-sessions');
    expect(filterLynxSettingsPages('skills.installed')).toHaveLength(1);
    expect(filterLynxSettingsPages('zzzz-nope')).toHaveLength(0);
  });

  test('stays aligned with Cap metadata titles for mobile slugs', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/lib/settings/metadata.ts'), 'utf8');
    for (const page of LYNX_SETTINGS_PAGE_METADATA) {
      if (page.slug === 'archived-sessions') {
        // Cap main owns this slug; tip packages/ui may still be the older 21-slug list.
        expect(page.title).toBe('Archived sessions');
        continue;
      }
      expect(source).toContain(`slug: '${page.slug}'`);
      expect(source).toContain(`title: '${page.title}'`);
    }
    expect(source).not.toContain("slug: 'iosNativeUi'");
  });
});
