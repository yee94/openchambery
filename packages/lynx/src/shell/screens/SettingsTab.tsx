import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import { LYNX_MOBILE_SETTINGS_PAGE_SLUGS } from '../../settings/slugs';
import { cssVar } from '../../theme/tokens';

export function SettingsTab({ locale }: { locale: string }) {
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
      <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '16px' }}>
        {lynxT(locale, 'lynx.shell.settings.stub')}
      </LynxText>
      {LYNX_MOBILE_SETTINGS_PAGE_SLUGS.map((slug) => (
        <LynxView
          key={slug}
          style={{
            padding: '12px 0',
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground') }}>{slug}</LynxText>
        </LynxView>
      ))}
    </LynxScrollView>
  );
}
