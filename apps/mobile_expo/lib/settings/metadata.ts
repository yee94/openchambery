/**
 * Cap MOBILE_SETTINGS_PAGE_SLUGS parity. Voice omitted (no STT/TTS).
 */

export type SettingsPageSlug =
  | 'instances'
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'sessions'
  | 'summary-ai'
  | 'projects'
  | 'git'
  | 'providers'
  | 'agents'
  | 'assistants'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'magic-prompts'
  | 'snippets'
  | 'skills.installed'
  | 'usage'
  | 'about';

export type SettingsPageGroup =
  | 'connection'
  | 'personalization'
  | 'workspace'
  | 'opencode'
  | 'content'
  | 'system';

export const SETTINGS_PAGE_GROUP_ORDER: readonly SettingsPageGroup[] = [
  'connection',
  'personalization',
  'workspace',
  'opencode',
  'content',
  'system',
] as const;

const SETTINGS_PAGE_ORDER: readonly SettingsPageSlug[] = [
  'instances',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'summary-ai',
  'projects',
  'git',
  'providers',
  'agents',
  'assistants',
  'behavior',
  'commands',
  'mcp',
  'plugins',
  'magic-prompts',
  'snippets',
  'skills.installed',
  'usage',
  'about',
] as const;

/** Cap MOBILE_SETTINGS_PAGE_SLUGS minus Voice. */
export const EXPO_SETTINGS_PAGE_SLUGS = [
  'instances',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'summary-ai',
  'projects',
  'git',
  'providers',
  'agents',
  'assistants',
  'behavior',
  'commands',
  'mcp',
  'plugins',
  'magic-prompts',
  'snippets',
  'skills.installed',
  'usage',
  'about',
] as const satisfies readonly SettingsPageSlug[];

export type SettingsPageMeta = {
  slug: SettingsPageSlug;
  titleKey: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  keywords: string[];
};

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'instances',
    titleKey: 'settings.pages.instances',
    group: 'connection',
    kind: 'single',
    keywords: ['instance', 'instances', 'server', 'connection', 'switch'],
  },
  {
    slug: 'appearance',
    titleKey: 'settings.pages.appearance',
    group: 'personalization',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    titleKey: 'settings.pages.chat',
    group: 'personalization',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'],
  },
  {
    slug: 'notifications',
    titleKey: 'settings.pages.notifications',
    group: 'personalization',
    kind: 'single',
    keywords: ['alerts', 'native', 'summary', 'summarization'],
  },
  {
    slug: 'sessions',
    titleKey: 'settings.pages.sessions',
    group: 'personalization',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen'],
  },
  {
    slug: 'summary-ai',
    titleKey: 'settings.pages.summaryAi',
    group: 'personalization',
    kind: 'single',
    keywords: ['summary', 'commit', 'session title', 'prompt', 'provider', 'custom api', 'base url', 'api token'],
  },
  {
    slug: 'projects',
    titleKey: 'settings.pages.projects',
    group: 'workspace',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'git',
    titleKey: 'settings.pages.git',
    group: 'workspace',
    kind: 'single',
    keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'],
  },
  {
    slug: 'providers',
    titleKey: 'settings.pages.providers',
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'agents',
    titleKey: 'settings.pages.agents',
    group: 'opencode',
    kind: 'split',
    keywords: ['agent', 'agents', 'prompts', 'tools', 'permissions'],
  },
  {
    slug: 'assistants',
    titleKey: 'settings.pages.assistants',
    group: 'opencode',
    kind: 'split',
    keywords: ['assistant', 'assistants', 'sharing'],
  },
  {
    slug: 'behavior',
    titleKey: 'settings.pages.behavior',
    group: 'opencode',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'global rules', 'instructions', 'override'],
  },
  {
    slug: 'commands',
    titleKey: 'settings.pages.commands',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros', 'automation'],
  },
  {
    slug: 'mcp',
    titleKey: 'settings.pages.mcp',
    group: 'opencode',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'servers', 'tools', 'remote', 'stdio'],
  },
  {
    slug: 'plugins',
    titleKey: 'settings.pages.plugins',
    group: 'opencode',
    kind: 'split',
    keywords: ['plugin', 'plugins', 'extensions', 'addons', 'npm', 'opencode-wakatime'],
  },
  {
    slug: 'magic-prompts',
    titleKey: 'settings.pages.magicPrompts',
    group: 'content',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'],
  },
  {
    slug: 'snippets',
    titleKey: 'settings.pages.snippets',
    group: 'content',
    kind: 'split',
    keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'],
  },
  {
    slug: 'skills.installed',
    titleKey: 'settings.pages.skills',
    group: 'content',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'usage',
    titleKey: 'settings.pages.usage',
    group: 'system',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'about',
    titleKey: 'settings.pages.about',
    group: 'system',
    kind: 'single',
    keywords: ['about', 'version', 'updates', 'release', 'changelog'],
  },
] as const;

export const SETTINGS_GROUP_TITLE_KEYS: Record<SettingsPageGroup, string> = {
  connection: 'settings.groups.connection',
  personalization: 'settings.groups.personalization',
  workspace: 'settings.groups.workspace',
  opencode: 'settings.groups.opencode',
  content: 'settings.groups.content',
  system: 'settings.groups.system',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return SETTINGS_PAGE_METADATA.find((page) => page.slug === normalized) ?? null;
}

export function resolveExpoSettingsSlug(value: string | null | undefined): SettingsPageSlug | 'home' {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'home') return 'home';
  if (normalized === 'voice') return 'home';
  const meta = getSettingsPageMeta(normalized);
  return meta ? meta.slug : 'home';
}

export function groupSettingsPages(
  pages: readonly SettingsPageMeta[] = SETTINGS_PAGE_METADATA,
): Array<{ group: SettingsPageGroup; pages: SettingsPageMeta[] }> {
  const rank = new Map<SettingsPageSlug, number>(SETTINGS_PAGE_ORDER.map((slug, index) => [slug, index]));
  const pagesByGroup = new Map<SettingsPageGroup, SettingsPageMeta[]>();
  for (const page of pages) {
    const groupPages = pagesByGroup.get(page.group) ?? [];
    groupPages.push(page);
    pagesByGroup.set(page.group, groupPages);
  }
  return SETTINGS_PAGE_GROUP_ORDER.flatMap((group) => {
    const groupPages = pagesByGroup.get(group);
    if (!groupPages?.length) return [];
    return [{
      group,
      pages: groupPages.sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999)),
    }];
  });
}
