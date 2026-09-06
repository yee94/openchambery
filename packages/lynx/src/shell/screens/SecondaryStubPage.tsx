import { lynxT } from '../../i18n/catalog';
import { LynxText, LynxView } from '../../lynx-elements';
import { cssVar } from '../../theme/tokens';
import type { LynxSecondaryKind } from '../navigation';

const TITLE_KEY = {
  chat: 'lynx.shell.chat.title',
  draft: 'lynx.shell.chat.title',
  assistant: 'mobile.tabs.assistant',
  instances: 'mobile.tabs.settings',
} as const;

const BODY_KEY = {
  chat: 'lynx.shell.chat.stub',
  draft: 'lynx.shell.chat.stub',
  assistant: 'lynx.shell.stub.body',
  instances: 'lynx.shell.stub.body',
} as const;

export function SecondaryStubPage({
  locale,
  kind,
  onBack,
}: {
  locale: string;
  kind: LynxSecondaryKind;
  onBack: () => void;
}) {
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
          <LynxText style={{ color: cssVar('primary.base') }}>{lynxT(locale, 'lynx.shell.back')}</LynxText>
        </LynxView>
        <LynxText
          style={{
            marginLeft: '12px',
            color: cssVar('surface.foreground'),
            fontWeight: '600',
          }}
        >
          {lynxT(locale, TITLE_KEY[kind])}
        </LynxText>
      </LynxView>
      <LynxText style={{ padding: '16px', color: cssVar('surface.mutedForeground') }}>
        {lynxT(locale, BODY_KEY[kind])}
      </LynxText>
    </LynxView>
  );
}
