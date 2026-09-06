import type { LynxMessageKey } from '../../i18n/catalog';
import { lynxT } from '../../i18n/catalog';
import { cssVar } from '../../theme/tokens';

export type StubPageProps = {
  locale: string;
  title: string;
  bodyKey: LynxMessageKey;
  extra?: string;
};

export function StubPage({ locale, title, bodyKey, extra }: StubPageProps) {
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
        {title}
      </text>
      <text style={{ color: cssVar('surface.mutedForeground'), lineHeight: '22px' }}>
        {lynxT(locale, bodyKey)}
      </text>
      {extra ? (
        <text style={{ color: cssVar('surface.mutedForeground'), marginTop: '16px' }}>
          {extra}
        </text>
      ) : null}
    </scroll-view>
  );
}
