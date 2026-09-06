/**
 * Mobile Settings page metadata aligned with Cap
 * `packages/ui/src/lib/settings/metadata.ts` (MOBILE_SETTINGS_PAGE_SLUGS only).
 * No iosNativeUi toggle. No invented slugs.
 */
import {
  LYNX_MOBILE_SETTINGS_PAGE_SLUGS,
  type LynxMobileSettingsSlug,
} from './slugs';

export type LynxSettingsPageGroup =
  | 'connection'
  | 'personalization'
  | 'workspace'
  | 'opencode'
  | 'content'
  | 'system';

export type LynxSettingsPageKind = 'single' | 'split';

export type LynxSettingsPageMeta = {
  slug: LynxMobileSettingsSlug;
  title: string;
  group: LynxSettingsPageGroup;
  kind: LynxSettingsPageKind;
  keywords: readonly string[];
  /** Body wiring status for this slice. */
  body: 'stub' | 'list-only-until-routes';
};

export const LYNX_SETTINGS_PAGE_GROUP_ORDER: readonly LynxSettingsPageGroup[] = [
  'connection',
  'personalization',
  'workspace',
  'opencode',
  'content',
  'system',
] as const;

export const LYNX_SETTINGS_GROUP_LABEL: Record<LynxSettingsPageGroup, string> = {
  connection: 'Connection',
  personalization: 'Personalization',
  workspace: 'Workspace',
  opencode: 'OpenCode',
  content: 'Content',
  system: 'System',
};

/**
 * Titles/groups/keywords mirror Cap SETTINGS_PAGE_METADATA for the 21 mobile slugs.
 * Keep order identical to LYNX_MOBILE_SETTINGS_PAGE_SLUGS / Cap MOBILE list.
 */
export const LYNX_SETTINGS_PAGE_METADATA: readonly LynxSettingsPageMeta[] = [
  {
    slug: 'instances',
    title: 'Switch instance',
    group: 'connection',
    kind: 'single',
    keywords: ['instance', 'instances', 'server', 'connection', 'switch'],
    body: 'stub',
  },
  {
    slug: 'appearance',
    title: 'Appearance',
    group: 'personalization',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'language'],
    body: 'stub',
  },
  {
    slug: 'chat',
    title: 'Chat',
    group: 'personalization',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'draft', 'queue', 'output'],
    body: 'stub',
  },
  {
    slug: 'notifications',
    title: 'Notifications',
    group: 'personalization',
    kind: 'single',
    keywords: ['alerts', 'native', 'summary', 'summarization'],
    body: 'stub',
  },
  {
    slug: 'sessions',
    title: 'Sessions',
    group: 'personalization',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory'],
    body: 'stub',
  },
  {
    slug: 'summary-ai',
    title: 'Summary AI',
    group: 'personalization',
    kind: 'single',
    keywords: ['summary', 'commit', 'session title', 'prompt', 'provider'],
    body: 'stub',
  },
  {
    slug: 'projects',
    title: 'Projects',
    group: 'workspace',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'repo', 'directory'],
    body: 'stub',
  },
  {
    slug: 'git',
    title: 'Git',
    group: 'workspace',
    kind: 'single',
    keywords: ['git', 'identity', 'identities', 'gitmoji', 'commit'],
    body: 'stub',
  },
  {
    slug: 'providers',
    title: 'Providers',
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'api key', 'credentials'],
    body: 'stub',
  },
  {
    slug: 'agents',
    title: 'Agents',
    group: 'opencode',
    kind: 'split',
    keywords: ['agent', 'agents', 'prompts', 'tools', 'permissions'],
    body: 'stub',
  },
  {
    slug: 'assistants',
    title: 'Assistants',
    group: 'opencode',
    kind: 'split',
    keywords: ['assistant', 'assistants', 'sharing'],
    body: 'stub',
  },
  {
    slug: 'behavior',
    title: 'Behavior',
    group: 'opencode',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'instructions'],
    body: 'stub',
  },
  {
    slug: 'commands',
    title: 'Commands',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros'],
    body: 'stub',
  },
  {
    slug: 'mcp',
    title: 'MCP',
    group: 'opencode',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'servers', 'tools'],
    body: 'stub',
  },
  {
    slug: 'plugins',
    title: 'Plugins',
    group: 'opencode',
    kind: 'split',
    keywords: ['plugin', 'plugins', 'extensions'],
    body: 'stub',
  },
  {
    slug: 'magic-prompts',
    title: 'Magic Prompts',
    group: 'content',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'review', 'commit'],
    body: 'stub',
  },
  {
    slug: 'snippets',
    title: 'Snippets',
    group: 'content',
    kind: 'split',
    keywords: ['prompt', 'templates', 'multi-run'],
    body: 'stub',
  },
  {
    slug: 'skills.installed',
    title: 'Skills',
    group: 'content',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install'],
    body: 'stub',
  },
  {
    slug: 'usage',
    title: 'Usage',
    group: 'system',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
    body: 'stub',
  },
  {
    slug: 'voice',
    title: 'Voice',
    group: 'system',
    kind: 'single',
    keywords: ['tts', 'speech', 'voice', 'dictation'],
    body: 'list-only-until-routes',
  },
  {
    slug: 'about',
    title: 'About',
    group: 'system',
    kind: 'single',
    keywords: ['about', 'version', 'updates', 'release', 'changelog'],
    body: 'stub',
  },
] as const;

const META_BY_SLUG = new Map(
  LYNX_SETTINGS_PAGE_METADATA.map((page) => [page.slug, page]),
);

export function getLynxSettingsPageMeta(
  slug: string,
): LynxSettingsPageMeta | null {
  return META_BY_SLUG.get(slug as LynxMobileSettingsSlug) ?? null;
}

export function groupLynxSettingsPages(
  pages: readonly LynxSettingsPageMeta[] = LYNX_SETTINGS_PAGE_METADATA,
): Array<{ group: LynxSettingsPageGroup; pages: LynxSettingsPageMeta[] }> {
  const rank = new Map<LynxMobileSettingsSlug, number>(
    LYNX_MOBILE_SETTINGS_PAGE_SLUGS.map((slug, index) => [slug, index]),
  );
  const pagesByGroup = new Map<LynxSettingsPageGroup, LynxSettingsPageMeta[]>();

  for (const page of pages) {
    const groupPages = pagesByGroup.get(page.group) ?? [];
    groupPages.push(page);
    pagesByGroup.set(page.group, groupPages);
  }

  return LYNX_SETTINGS_PAGE_GROUP_ORDER.flatMap((group) => {
    const groupPages = pagesByGroup.get(group);
    if (!groupPages?.length) return [];
    return [{
      group,
      pages: groupPages.sort(
        (a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999),
      ),
    }];
  });
}

export function filterLynxSettingsPages(
  query: string,
  pages: readonly LynxSettingsPageMeta[] = LYNX_SETTINGS_PAGE_METADATA,
): LynxSettingsPageMeta[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...pages];
  return pages.filter((page) => {
    if (page.slug.toLowerCase().includes(normalized)) return true;
    if (page.title.toLowerCase().includes(normalized)) return true;
    if (page.group.toLowerCase().includes(normalized)) return true;
    return page.keywords.some((keyword) => keyword.toLowerCase().includes(normalized));
  });
}

/** Forbidden Cap-era toggle — Lynx is native; do not ship this row. */
export const LYNX_FORBIDDEN_SETTINGS_TOGGLES = ['iosNativeUi', 'openchamber.iosNativeUi'] as const;
