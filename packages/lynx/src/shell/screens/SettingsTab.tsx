import { useMemo, useState } from 'react';

import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import {
  filterLynxSettingsPages,
  groupLynxSettingsPages,
  LYNX_SETTINGS_GROUP_LABEL,
  type LynxSettingsPageMeta,
} from '../../settings/metadata';
import { LynxSettingsPage } from '../../settings/SettingsPage';
import type { SettingsBodyContext } from '../../settings/SettingsBodies';
import type { LynxMobileSettingsSlug } from '../../settings/slugs';
import { cssVar } from '../../theme/tokens';

function SettingsSearchField({
  locale,
  value,
  onChange,
}: {
  locale: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <LynxView
      style={{
        marginBottom: '16px',
        padding: '10px 12px',
        borderRadius: '12px',
        backgroundColor: cssVar('surface.elevated'),
      }}
    >
      <LynxText
        style={{ color: value ? cssVar('surface.foreground') : cssVar('surface.mutedForeground') }}
        bindtap={() => {
          if (!value) onChange('');
        }}
      >
        {value || lynxT(locale, 'lynx.settings.search.placeholder')}
      </LynxText>
      <LynxView
        id="lynx-settings-search"
        bindtap={() => onChange(value)}
        style={{ height: '0px' }}
      />
    </LynxView>
  );
}

function SettingsRow({
  page,
  onOpen,
}: {
  page: LynxSettingsPageMeta;
  onOpen: (slug: LynxMobileSettingsSlug) => void;
}) {
  return (
    <LynxView
      key={page.slug}
      bindtap={() => onOpen(page.slug)}
      accessibility-role="button"
      accessibility-label={page.title}
      style={{
        padding: '14px 0',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <LynxView>
        <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '16px' }}>
          {page.title}
        </LynxText>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {page.slug} · {page.body}
        </LynxText>
      </LynxView>
      <LynxText style={{ color: cssVar('surface.mutedForeground') }}>›</LynxText>
    </LynxView>
  );
}

/**
 * Settings tab: search + grouped 21 mobile slugs + in-tab push pages.
 * Dock stays visible (not a secondary chat-style page).
 */
export function SettingsTab({
  locale,
  bodyContext,
  searchQuery: searchQueryProp,
  onSearchQueryChange,
}: {
  locale: string;
  bodyContext: SettingsBodyContext;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
}) {
  const [internalQuery, setInternalQuery] = useState('');
  const [activeSlug, setActiveSlug] = useState<LynxMobileSettingsSlug | null>(null);
  const searchQuery = searchQueryProp ?? internalQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalQuery;

  const filtered = useMemo(
    () => filterLynxSettingsPages(searchQuery),
    [searchQuery],
  );
  const groups = useMemo(() => groupLynxSettingsPages(filtered), [filtered]);

  if (activeSlug) {
    return (
      <LynxSettingsPage
        locale={locale}
        slug={activeSlug}
        onBack={() => setActiveSlug(null)}
        bodyContext={bodyContext}
      />
    );
  }

  return (
    <LynxScrollView
      style={{
        flexGrow: 1,
        padding: '24px 16px',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxText
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: cssVar('surface.foreground'),
          marginBottom: '12px',
        }}
      >
        {tabLabel(locale, 'settings')}
      </LynxText>
      <SettingsSearchField
        locale={locale}
        value={searchQuery}
        onChange={setSearchQuery}
      />
      {groups.length === 0 ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.settings.search.empty')}
        </LynxText>
      ) : (
        groups.map(({ group, pages }) => (
          <LynxView key={group} style={{ marginBottom: '20px' }}>
            <LynxText
              style={{
                color: cssVar('surface.mutedForeground'),
                fontSize: '13px',
                fontWeight: '600',
                marginBottom: '4px',
                textTransform: 'uppercase',
              }}
            >
              {LYNX_SETTINGS_GROUP_LABEL[group]}
            </LynxText>
            {pages.map((page) => (
              <SettingsRow key={page.slug} page={page} onOpen={setActiveSlug} />
            ))}
          </LynxView>
        ))
      )}
    </LynxScrollView>
  );
}
