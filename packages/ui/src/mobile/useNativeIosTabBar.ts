import { useEffect, useRef, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';

import {
  hasActiveMobileOverlay,
  MOBILE_OVERLAY_ACTIVE_ATTRIBUTE,
} from '@/components/ui/MobileOverlayPresence';
import {
  canUseNativeIosTabBar,
  getNativeIosTabBarPlugin,
  nativeIosTabBarAccentFromRoot,
  nativeIosTabBarAppearanceFromRoot,
  nativeTabBarStatesEqual,
  parseNativeIosTabId,
  resolveNativeIosTabBarVisible,
  setNativeTabBarDocumentClass,
  type NativeIosTabBarItem,
  type NativeIosTabBarState,
} from '@/lib/native-ios-tab-bar';
import type { MobileTabId } from './mobileTabs';

const MOBILE_OVERLAY_ROOT_ID = 'mobile-overlay-root';

export type UseNativeIosTabBarArgs = {
  visible: boolean;
  activeTab: MobileTabId;
  tabs: readonly NativeIosTabBarItem[];
  ariaLabel: string;
  onTabChange: (tab: MobileTabId) => void;
};

export type NativeIosTabBarMode = 'web' | 'pending' | 'native';

/**
 * Drives the Capacitor iOS liquid-glass homepage dock. Tab content stays
 * React-owned; native only paints the dock and emits `tabSelected`.
 * Older iOS / web / Android keep the Web `MobileTabBar`.
 */
export function useNativeIosTabBar(args: UseNativeIosTabBarArgs): NativeIosTabBarMode {
  const available = canUseNativeIosTabBar();
  const [adopted, setAdopted] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const lastStateRef = useRef<NativeIosTabBarState | null>(null);
  const rejectedRef = useRef(false);
  const onTabChange = useEvent(args.onTabChange);
  const tabsKey = args.tabs.map((tab) => `${tab.id}:${tab.label}`).join('|');
  const appearance = typeof document === 'undefined'
    ? 'dark'
    : nativeIosTabBarAppearanceFromRoot(document.documentElement);
  const accentColor = typeof document === 'undefined' ? '' : nativeIosTabBarAccentFromRoot();

  useEffect(() => {
    if (!available || typeof document === 'undefined') return;
    let host = document.getElementById(MOBILE_OVERLAY_ROOT_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = MOBILE_OVERLAY_ROOT_ID;
      document.body.appendChild(host);
    }
    const update = () => setOverlayBusy(hasActiveMobileOverlay(host.children));
    update();
    const observer = new MutationObserver(update);
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [MOBILE_OVERLAY_ACTIVE_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, [available]);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const plugin = getNativeIosTabBarPlugin();
    const handles: PluginListenerHandle[] = [];

    void plugin.addListener('tabSelected', (payload) => {
      const tab = parseNativeIosTabId(payload.tab);
      if (tab) onTabChange(tab);
    }).then((handle) => {
      if (cancelled) {
        void handle.remove();
        return;
      }
      handles.push(handle);
    });

    return () => {
      cancelled = true;
      lastStateRef.current = null;
      void plugin.hide();
      for (const handle of handles) void handle.remove();
      if (typeof document !== 'undefined') {
        setNativeTabBarDocumentClass(document.documentElement, false);
      }
    };
  }, [available]);

  useEffect(() => {
    if (!available || rejectedRef.current) return;
    let cancelled = false;
    const plugin = getNativeIosTabBarPlugin();
    const state: NativeIosTabBarState = {
      tabs: args.tabs.map((tab) => ({ id: tab.id, label: tab.label })),
      selectedTab: args.activeTab,
      appearance,
      accentColor,
      ariaLabel: args.ariaLabel,
    };

    const visible = resolveNativeIosTabBarVisible(args.visible, overlayBusy);
    const sync = async () => {
      if (!visible) {
        lastStateRef.current = null;
        await plugin.hide();
        return;
      }
      if (lastStateRef.current && nativeTabBarStatesEqual(lastStateRef.current, state)) {
        return;
      }
      const result = await plugin.present(state);
      if (cancelled) return;
      if (result.adopted !== true) {
        rejectedRef.current = true;
        setRejected(true);
        setAdopted(false);
        if (typeof document !== 'undefined') {
          setNativeTabBarDocumentClass(document.documentElement, false);
        }
        return;
      }
      lastStateRef.current = state;
      setAdopted(true);
      if (typeof document !== 'undefined') {
        setNativeTabBarDocumentClass(document.documentElement, true);
      }
    };

    void sync().catch(() => {
      if (cancelled) return;
      rejectedRef.current = true;
      setRejected(true);
      setAdopted(false);
      if (typeof document !== 'undefined') {
        setNativeTabBarDocumentClass(document.documentElement, false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [available, args.visible, overlayBusy, args.activeTab, args.ariaLabel, appearance, accentColor, tabsKey]);

  if (!available || rejected) return 'web';
  if (adopted) return 'native';
  return 'pending';
}
