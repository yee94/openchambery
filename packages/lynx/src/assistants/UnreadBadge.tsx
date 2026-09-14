import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import { formatLynxAssistantUnreadBadge } from './unread';

export type LynxAssistantUnreadBadgeProps = {
  locale: string;
  count: number;
};

/**
 * Cap `AssistantUnreadBadge` spirit — hide when count is not > 0, 99+ cap,
 * aria-label from catalog. Uses Cap status-info tokens (resolved Flexoki hex).
 */
export function LynxAssistantUnreadBadge({ locale, count }: LynxAssistantUnreadBadgeProps) {
  const badge = formatLynxAssistantUnreadBadge(count);
  if (!badge.visible) return null;
  return (
    <LynxView
      accessibility-role="text"
      accessibility-label={lynxT(locale, 'lynx.assistant.unread.label', { count: badge.count })}
      data-lynx-assistant-unread-badge="true"
      data-lynx-assistant-unread-count={String(badge.count)}
      style={{
        minWidth: '18px',
        height: '18px',
        paddingLeft: '6px',
        paddingRight: '6px',
        borderRadius: '999px',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: cssVar('status.info'),
      }}
    >
      <LynxText
        style={{
          color: cssVar('status.onInfo'),
          fontSize: '11px',
          fontWeight: '700',
        }}
      >
        {badge.display}
      </LynxText>
    </LynxView>
  );
}
