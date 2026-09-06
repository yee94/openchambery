import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import { cssVar } from '../../theme/tokens';

export function ProjectsHome({
  locale,
  onOpenStubChat,
}: {
  locale: string;
  onOpenStubChat?: () => void;
}) {
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
        {tabLabel(locale, 'projects')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), lineHeight: '22px' }}>
        {lynxT(locale, 'lynx.shell.stub.body')}
      </LynxText>
      {onOpenStubChat ? (
        <LynxView
          bindtap={onOpenStubChat}
          accessibility-label={lynxT(locale, 'lynx.shell.stub.openChat')}
          style={{ marginTop: '24px' }}
        >
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.stub.openChat')}
          </LynxText>
        </LynxView>
      ) : null}
    </LynxScrollView>
  );
}
