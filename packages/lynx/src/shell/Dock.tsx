import { GlassChrome } from '../glass/GlassChrome';
import type { LynxHostGlobalProps } from '../host/embedding';
import { lynxT, tabLabel } from '../i18n/catalog';
import { cssVar } from '../theme/tokens';
import { LYNX_TABS, type LynxTabId } from './tabs';

export type LynxDockProps = {
  host: LynxHostGlobalProps;
  activeTab: LynxTabId;
  visible: boolean;
  onTabSelected: (tab: LynxTabId) => void;
};

/**
 * Mode A only. Mode B host `UITabBar` must not be paired with this dock.
 */
export function LynxDock({ host, activeTab, visible, onTabSelected }: LynxDockProps) {
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
        return (
          <view
            key={tab.id}
            id={`lynx-tab-${tab.id}`}
            bindtap={() => onTabSelected(tab.id)}
            accessibility-role="tab"
            accessibility-label={label}
            style={{
              flexGrow: 1,
              minWidth: 0,
              alignItems: 'center',
              color: selected ? cssVar('primary.base') : cssVar('surface.mutedForeground'),
            }}
          >
            <text>{label}</text>
          </view>
        );
      })}
    </GlassChrome>
  );
}
