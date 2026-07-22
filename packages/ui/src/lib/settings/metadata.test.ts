import { describe, expect, test } from 'bun:test';

import { SETTINGS_PAGE_GROUP_ORDER, SETTINGS_PAGE_METADATA, groupSettingsPages } from './metadata';

describe('settings navigation metadata', () => {
  test('keeps the navigation information architecture complete', () => {
    expect(SETTINGS_PAGE_GROUP_ORDER).toEqual([
      'personalization',
      'workspace',
      'opencode',
      'content',
      'system',
    ]);

    const pagesByGroup = Object.fromEntries(groupSettingsPages(
      SETTINGS_PAGE_METADATA.filter((page) => page.slug !== 'home'),
    ).map(({ group, pages }) => [group, pages.map((page) => page.slug)]));

    expect(pagesByGroup).toEqual({
      personalization: ['appearance', 'chat', 'notifications', 'sessions', 'summary-ai', 'shortcuts'],
      workspace: ['projects', 'git', 'remote-instances'],
      opencode: ['providers', 'agents', 'assistants', 'behavior', 'commands', 'mcp', 'plugins', 'global-config'],
      content: ['magic-prompts', 'snippets', 'skills.installed', 'skills.catalog'],
      system: ['usage', 'voice', 'tunnel', 'about'],
    });
  });

  test('omits groups without visible pages', () => {
    const visiblePages = SETTINGS_PAGE_METADATA.filter((page) => ['appearance', 'projects'].includes(page.slug));

    expect(groupSettingsPages(visiblePages).map(({ group }) => group)).toEqual([
      'personalization',
      'workspace',
    ]);
  });

  test('renders assistants through the standard split settings shell', () => {
    expect(SETTINGS_PAGE_METADATA.find((page) => page.slug === 'assistants')?.kind).toBe('split');
  });
});
