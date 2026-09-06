import {
  EXPO_SETTINGS_PAGE_SLUGS,
  SETTINGS_GROUP_TITLE_KEYS,
  SETTINGS_PAGE_METADATA,
  getSettingsPageMeta,
  groupSettingsPages,
  type SettingsPageGroup,
  type SettingsPageMeta,
  type SettingsPageSlug,
} from '@/lib/settings/metadata';

export type SettingsHomeGroup = {
  group: SettingsPageGroup;
  titleKey: string;
  pages: SettingsPageMeta[];
};

export type SettingsSearchHit = {
  slug: SettingsPageSlug;
  titleKey: string;
  groupTitleKey: string;
  keywords: string[];
};

const normalize = (value: string): string => value.trim().toLocaleLowerCase();

export function buildSettingsHomeGroups(
  pages: readonly SettingsPageMeta[] = SETTINGS_PAGE_METADATA,
): SettingsHomeGroup[] {
  return groupSettingsPages(pages).map(({ group, pages: groupPages }) => ({
    group,
    titleKey: SETTINGS_GROUP_TITLE_KEYS[group],
    pages: groupPages,
  }));
}

export function searchSettingsPages(
  query: string,
  options?: {
    translate?: (key: string) => string;
    pages?: readonly SettingsPageMeta[];
  },
): SettingsSearchHit[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const pages = options?.pages ?? SETTINGS_PAGE_METADATA;
  const translate = options?.translate ?? ((key: string) => key);

  return pages.flatMap((page) => {
    const title = translate(page.titleKey);
    const groupTitle = translate(SETTINGS_GROUP_TITLE_KEYS[page.group]);
    const haystack = normalize([title, groupTitle, page.slug, ...page.keywords].join(' '));
    if (!terms.every((term) => haystack.includes(term))) return [];
    return [{
      slug: page.slug,
      titleKey: page.titleKey,
      groupTitleKey: SETTINGS_GROUP_TITLE_KEYS[page.group],
      keywords: page.keywords,
    }];
  });
}

export function isExpoSettingsSlug(value: string): value is SettingsPageSlug {
  return (EXPO_SETTINGS_PAGE_SLUGS as readonly string[]).includes(value);
}

export function settingsPageTitleKey(slug: string): string | null {
  return getSettingsPageMeta(slug)?.titleKey ?? null;
}
