import { lynxT, tabLabel } from '../../i18n/catalog';
import { LYNX_MOBILE_SETTINGS_PAGE_SLUGS } from '../../settings/slugs';
import { cssVar } from '../../theme/tokens';

export function SettingsTab({ locale }: { locale: string }) {
  return (
    <scroll-view
      style={{
        flexGrow: 1,
        padding: '24px 16px',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <text
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: cssVar('surface.foreground'),
          marginBottom: '12px',
        }}
      >
        {tabLabel(locale, 'settings')}
      </text>
      <text style={{ color: cssVar('surface.mutedForeground'), marginBottom: '16px' }}>
        {lynxT(locale, 'lynx.shell.settings.stub')}
      </text>
      {LYNX_MOBILE_SETTINGS_PAGE_SLUGS.map((slug) => (
        <view
          key={slug}
          style={{
            padding: '12px 0',
          }}
        >
          <text style={{ color: cssVar('surface.foreground') }}>{slug}</text>
        </view>
      ))}
    </scroll-view>
  );
}
