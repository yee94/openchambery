import { lynxT, tabLabel } from '../../i18n/catalog';
import { cssVar } from '../../theme/tokens';

export function ProjectsHome({
  locale,
  onOpenStubChat,
}: {
  locale: string;
  onOpenStubChat?: () => void;
}) {
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
        {tabLabel(locale, 'projects')}
      </text>
      <text style={{ color: cssVar('surface.mutedForeground'), lineHeight: '22px' }}>
        {lynxT(locale, 'lynx.shell.stub.body')}
      </text>
      {onOpenStubChat ? (
        <view
          bindtap={onOpenStubChat}
          accessibility-label={lynxT(locale, 'lynx.shell.stub.openChat')}
          style={{ marginTop: '24px' }}
        >
          <text style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.stub.openChat')}
          </text>
        </view>
      ) : null}
    </scroll-view>
  );
}
