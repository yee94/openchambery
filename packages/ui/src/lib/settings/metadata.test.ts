import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_SETTINGS_PAGE_SLUGS,
  SETTINGS_PAGE_GROUP_ORDER,
  SETTINGS_PAGE_METADATA,
  groupSettingsPages,
  type SettingsPageSlug,
} from './metadata';

describe('settings navigation metadata', () => {
  test('keeps the navigation information architecture complete', () => {
    expect(SETTINGS_PAGE_GROUP_ORDER).toEqual([
      'connection',
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
      connection: ['instances'],
      personalization: ['appearance', 'chat', 'notifications', 'sessions', 'summary-ai', 'shortcuts'],
      workspace: ['projects', 'git', 'remote-instances'],
      opencode: ['providers', 'agents', 'assistants', 'behavior', 'commands', 'mcp', 'plugins', 'global-config'],
      content: ['magic-prompts', 'snippets', 'skills.installed', 'skills.catalog'],
      system: ['usage', 'voice', 'about'],
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

  test('exposes every split collection to the shared three-level mobile flow', () => {
    const mobilePages = new Set<SettingsPageSlug>(MOBILE_SETTINGS_PAGE_SLUGS);
    const hiddenSplitPages = SETTINGS_PAGE_METADATA
      .filter((page) => page.kind === 'split')
      .map((page) => page.slug)
      .filter((slug) => !mobilePages.has(slug));

    expect(hiddenSplitPages).toEqual([]);
  });

  test('models native instance switching as a standard mobile Settings page', () => {
    const instancesPage = SETTINGS_PAGE_METADATA.find((page) => page.slug === 'instances');

    expect(instancesPage?.kind).toBe('single');
    expect(instancesPage?.isAvailable?.({
      isVSCode: false,
      isWeb: true,
      isDesktop: false,
      isMobile: true,
    })).toBe(true);
    expect(MOBILE_SETTINGS_PAGE_SLUGS).toContain('instances');
  });

  test('keeps native instance switching inside Settings and out of root tabs', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [mobileApp, settingsView, phoneShell, settingsTab] = await Promise.all([
      readFile(join(directory, '../../apps/MobileApp.tsx'), 'utf8'),
      readFile(join(directory, '../../components/views/SettingsView.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/settings/MobileSettingsTab.tsx'), 'utf8'),
    ]);
    const overflowMenu = mobileApp.slice(
      mobileApp.indexOf('const overflowItems'),
      mobileApp.indexOf('return (', mobileApp.indexOf('const overflowItems')),
    );

    expect(overflowMenu).not.toContain("key: 'instances'");
    // Phone overflow must not re-open Settings as a half-sheet; Settings is a root tab.
    expect(mobileApp).toContain("setActiveTab('settings')");
    expect(mobileApp).toContain('settingsOpen && isIPad');
    expect(settingsView).toContain('case "instances":');
    expect(settingsView).toContain('return mobileInstancesPage ?? renderUnavailable();');
    expect(settingsTab).toContain('mobileInstancesPage={instancesPage}');
    expect(settingsTab).toContain('autoOpenMobilePage');
    // The home quick-action menu may push instance management as a secondary
    // page above the Projects tab, but it never becomes a root surface: the
    // shell renders it only through the secondary-pages contract.
    expect(phoneShell).toContain('instancesSecondaryPage');
    expect(phoneShell).toContain("secondaryKind === 'instances'");
    expect(phoneShell).not.toContain('instances: (');
    // Secondary instances page must carry Settings workspace tokens so
    // SettingsGroup cards keep their chrome outside the Settings tab.
    expect(mobileApp).toContain('oc-settings-workspace oc-settings-workspace-mobile');
    expect(mobileApp).toContain('MobileFloatingSurface className="oc-mobile-settings-detail-card"');
    // Home-menu scan is a global Capacitor capability — never routed through
    // the instances secondary page via a pending-scan mount effect.
    expect(mobileApp).toContain('scanConnectionFromHome');
    expect(mobileApp).not.toContain('pendingInstanceScanRef');
    expect(mobileApp).not.toContain('consumePendingScanRequest');
    expect(mobileApp).not.toContain('scanInstanceFromProjects');
  });
});
