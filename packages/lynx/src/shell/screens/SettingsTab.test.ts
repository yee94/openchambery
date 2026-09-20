import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  filterLynxSettingsPages,
  groupLynxSettingsPages,
  LYNX_SETTINGS_PAGE_METADATA,
} from '../../settings/metadata';

const here = dirname(fileURLToPath(import.meta.url));

describe('SettingsTab search field wiring', () => {
  test('SettingsSearchField is a LynxInput bound to bindinput, not display-only chrome', async () => {
    const source = await readFile(join(here, 'SettingsTab.tsx'), 'utf8');
    expect(source).toContain('LynxInput');
    expect(source).toContain('id="lynx-settings-search"');
    expect(source).toContain('bindinput=');
    expect(source).toContain("lynxT(locale, 'lynx.settings.search.placeholder')");
    expect(source).toContain('filterLynxSettingsPages(searchQuery)');
    expect(source).toContain('onChange={setSearchQuery}');
    expect(source).not.toContain("height: '0px'");
    expect(source).not.toMatch(/value \|\| lynxT\(locale, 'lynx\.settings\.search\.placeholder'\)/);
  });

  test('search query filters the 22-slug catalog used by SettingsTab', () => {
    expect(filterLynxSettingsPages('')).toHaveLength(LYNX_SETTINGS_PAGE_METADATA.length);
    expect(filterLynxSettingsPages('')).toHaveLength(22);
    expect(filterLynxSettingsPages('theme').map((page) => page.slug)).toContain('appearance');
    expect(filterLynxSettingsPages('archive').map((page) => page.slug)).toContain('archived-sessions');
    expect(filterLynxSettingsPages('zzzz-nope')).toHaveLength(0);

    const filtered = filterLynxSettingsPages('theme');
    const groups = groupLynxSettingsPages(filtered);
    expect(groups.some((group) => group.pages.some((page) => page.slug === 'appearance'))).toBe(true);
    expect(groups.every((group) => group.pages.length > 0)).toBe(true);
  });
});
