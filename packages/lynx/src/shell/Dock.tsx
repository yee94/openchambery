import { LynxAssistantUnreadBadge } from '../assistants/UnreadBadge';
import { GlassChrome } from '../glass/GlassChrome';
import type { LynxHostGlobalProps } from '../host/embedding';
import { lynxT, tabLabel } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import { LYNX_TABS, type LynxTabId } from './tabs';

export type LynxDockProps = {
  host: LynxHostGlobalProps;
  activeTab: LynxTabId;
  visible: boolean;
  onTabSelected: (tab: LynxTabId) => void;
  /**
   * Cap Assistant dock unread total. `null` / omit = unknown (do not paint 0
   * as authoritative empty after a failed snapshot).
   */
  assistantUnreadCount?: number | null;
};

/**
 * Mode A only. Mode B host `UITabBar` must not be paired with this dock.
 */
export function LynxDock({
  host,
  activeTab,
  visible,
  onTabSelected,
  assistantUnreadCount = null,
}: LynxDockProps) {
  if (!visible) return null;

  return (
    <GlassChrome
      surface="dock"
      host={host}
      fullPageAutoGlassSkin
      accessibilityLabel={lynxT(host.locale, 'mobile.nav.aria')}
      style={{
        position: 'absolute',
        left: '16px',
        right: '16px',
        bottom: '12px',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        padding: '8px 12px',
      }}
    >
      {LYNX_TABS.map((tab) => {
        const selected = tab.id === activeTab;
        const label = tabLabel(host.locale, tab.id);
        const unread = tab.id === 'assistant' ? assistantUnreadCount : null;
        const unreadLabel = unread != null && unread > 0
          ? `${label}, ${lynxT(host.locale, 'lynx.assistant.unread.label', { count: unread })}`
          : label;
        return (
          <LynxView
            key={tab.id}
            id={`lynx-tab-${tab.id}`}
            bindtap={() => onTabSelected(tab.id)}
            accessibility-role="tab"
            accessibility-label={unreadLabel}
            data-lynx-dock-assistant-unread={tab.id === 'assistant' && unread != null && unread > 0 ? String(unread) : undefined}
            style={{
              flexGrow: 1,
              minWidth: 0,
              alignItems: 'center',
              color: selected ? cssVar('primary.base') : cssVar('surface.mutedForeground'),
            }}
          >
            <LynxView style={{ flexDirection: 'row', alignItems: 'center' }}>
              <LynxText>{label}</LynxText>
              {tab.id === 'assistant' && unread != null ? (
                <LynxAssistantUnreadBadge locale={host.locale} count={unread} />
              ) : null}
            </LynxView>
          </LynxView>
        );
      })}
    </GlassChrome>
  );
}
