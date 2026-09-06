import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import { getLynxSettingsPageMeta } from './metadata';
import type { LynxMobileSettingsSlug } from './slugs';
import { renderLynxSettingsBody, type SettingsBodyContext } from './SettingsBodies';

export type LynxSettingsPageProps = {
  locale: string;
  slug: LynxMobileSettingsSlug;
  onBack: () => void;
  bodyContext: SettingsBodyContext;
};

/**
 * Pushed settings page. Bodies are wired / list / labeled stubs per metadata.
 * Never fake-success. No iosNativeUi toggle.
 */
export function LynxSettingsPage({ locale, slug, onBack, bodyContext }: LynxSettingsPageProps) {
  const meta = getLynxSettingsPageMeta(slug);
  const title = meta?.title ?? slug;
  const bodyPolicy = meta?.body ?? 'stub';

  return (
    <LynxView
      style={{
        flexGrow: 1,
        backgroundColor: cssVar('surface.background'),
      }}
      accessibility-label={lynxT(locale, 'mobile.nav.secondaryPageAria')}
    >
      <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
        <LynxView bindtap={onBack} accessibility-label={lynxT(locale, 'lynx.shell.back')}>
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.back')}
          </LynxText>
        </LynxView>
        <LynxText
          style={{
            marginLeft: '12px',
            color: cssVar('surface.foreground'),
            fontWeight: '600',
          }}
        >
          {title}
        </LynxText>
      </LynxView>
      <LynxScrollView style={{ padding: '16px', flexGrow: 1 }}>
        <LynxText
          style={{
            color: cssVar('surface.mutedForeground'),
            marginBottom: '12px',
            fontSize: '12px',
          }}
        >
          {slug} · {meta?.kind ?? 'single'} · {bodyPolicy}
        </LynxText>
        {renderLynxSettingsBody(slug, bodyPolicy, bodyContext)}
      </LynxScrollView>
    </LynxView>
  );
}
