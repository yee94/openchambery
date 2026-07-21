import type { SidebarSection } from '@/constants/sidebar';

export type SettingsPageSlug =
  | 'home'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'usage'
  | 'agents'
  | 'assistants'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'global-config'
  | 'skills.installed'
  | 'skills.catalog'
  | 'git'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'summary-ai'
  | 'magic-prompts'
  | 'snippets'
  | 'notifications'
  | 'voice'
  | 'tunnel'
  | 'about';

export type SettingsPageGroup =
  | 'personalization'
  | 'workspace'
  | 'opencode'
  | 'content'
  | 'system';

export const SETTINGS_PAGE_GROUP_ORDER: readonly SettingsPageGroup[] = [
  'personalization',
  'workspace',
  'opencode',
  'content',
  'system',
] as const;

const SETTINGS_PAGE_ORDER: readonly SettingsPageSlug[] = [
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'summary-ai',
  'shortcuts',
  'projects',
  'git',
  'remote-instances',
  'providers',
  'agents',
  'assistants',
  'behavior',
  'commands',
  'mcp',
  'plugins',
  'global-config',
  'magic-prompts',
  'snippets',
  'skills.installed',
  'skills.catalog',
  'usage',
  'voice',
  'tunnel',
  'about',
] as const;

export interface SettingsRuntimeContext {
  isVSCode: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  title: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  description?: string;
  keywords?: string[];
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'home',
    title: 'Settings',
    group: 'personalization',
    kind: 'single',
    description: 'Search and jump to common pages.',
    keywords: ['search', 'settings'],
  },
  {
    slug: 'projects',
    title: 'Projects',
    group: 'workspace',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'remote-instances',
    title: 'Remote Instances',
    group: 'workspace',
    kind: 'single',
    keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'providers',
    title: 'Providers',
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'usage',
    title: 'Usage',
    group: 'system',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'agents',
    title: 'Agents',
    group: 'opencode',
    kind: 'split',
    keywords: ['agent', 'agents', 'prompts', 'tools', 'permissions'],
  },
  {
    slug: 'assistants',
    title: 'Assistants',
    group: 'opencode',
    kind: 'single',
    keywords: ['assistant', 'assistants', 'inbox', 'topics', 'sharing'],
  },
  {
    slug: 'behavior',
    title: 'Behavior',
    group: 'opencode',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'global rules', 'instructions', 'override'],
  },
  {
    slug: 'commands',
    title: 'Commands',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros', 'automation'],
  },
  {
    slug: 'mcp',
    title: 'MCP',
    group: 'opencode',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'servers', 'tools', 'remote', 'stdio'],
  },
  {
    slug: 'plugins',
    title: 'Plugins',
    group: 'opencode',
    kind: 'split',
    keywords: ['plugin', 'plugins', 'extensions', 'addons', 'npm', 'opencode-wakatime'],
  },
  {
    slug: 'global-config',
    title: 'Global Configuration',
    group: 'opencode',
    kind: 'single',
    keywords: ['global', 'configuration', 'opencode.json', 'opencode.jsonc', 'oh-my-opencode', 'oh-my-openagent'],
  },
  {
    slug: 'skills.installed',
    title: 'Skills',
    group: 'content',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'skills.catalog',
    title: 'Skills Catalog',
    group: 'content',
    kind: 'single',
    keywords: ['install', 'catalog', 'external', 'repository', 'skills catalog'],
  },
  {
    slug: 'git',
    title: 'Git',
    group: 'workspace',
    kind: 'single',
    keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'appearance',
    title: 'Appearance',
    group: 'personalization',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    title: 'Chat',
    group: 'personalization',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'],
  },
  {
    slug: 'shortcuts',
    title: 'Shortcuts',
    group: 'personalization',
    kind: 'single',
    keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'sessions',
    title: 'Sessions',
    group: 'personalization',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen'],
  },
  {
    slug: 'summary-ai',
    title: 'Summary AI',
    group: 'personalization',
    kind: 'single',
    keywords: ['summary', 'commit', 'session title', 'prompt', 'provider', 'custom api', 'base url', 'api token'],
  },
  {
    slug: 'magic-prompts',
    title: 'Magic Prompts',
    group: 'content',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'snippets',
    title: 'Snippets',
    group: 'content',
    kind: 'split',
    keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'],
  },

  { slug: 'notifications', title: 'Notifications', group: 'personalization', kind: 'single', keywords: ['alerts', 'native', 'summary', 'summarization'], },
  { slug: 'voice', title: 'Voice', group: 'system', kind: 'single', keywords: ['tts', 'speech', 'voice'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'tunnel', title: 'Remote Tunnel', group: 'system', kind: 'single', keywords: ['tunnel', 'cloudflare', 'qr', 'remote', 'mobile', 'share'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'about', title: 'About', group: 'system', kind: 'single', keywords: ['about', 'version', 'updates', 'release', 'changelog'], isAvailable: (ctx) => ctx.isMobile },
] as const;

export function groupSettingsPages(pages: readonly SettingsPageMeta[]): Array<{
  group: SettingsPageGroup;
  pages: SettingsPageMeta[];
}> {
  const rank = new Map<SettingsPageSlug, number>(SETTINGS_PAGE_ORDER.map((slug, index) => [slug, index]));
  const pagesByGroup = new Map<SettingsPageGroup, SettingsPageMeta[]>();

  for (const page of pages) {
    const groupPages = pagesByGroup.get(page.group) ?? [];
    groupPages.push(page);
    pagesByGroup.set(page.group, groupPages);
  }

  return SETTINGS_PAGE_GROUP_ORDER.flatMap((group) => {
    const groupPages = pagesByGroup.get(group);
    if (!groupPages?.length) {
      return [];
    }
    return [{
      group,
      pages: groupPages.sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999)),
    }];
  });
}

const LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG: Record<SidebarSection, SettingsPageSlug> = {
  sessions: 'sessions',
  agents: 'agents',
  commands: 'commands',
  mcp: 'mcp',
  skills: 'skills.installed',
  providers: 'providers',
  usage: 'usage',
  'git-identities': 'git',
  settings: 'home',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const legacy = (LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG as Record<string, SettingsPageSlug>)[normalized];
  if (legacy) {
    return legacy;
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}
