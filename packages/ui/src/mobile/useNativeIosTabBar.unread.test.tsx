import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  present: vi.fn().mockResolvedValue({ adopted: true }),
  hide: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
}));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => true }));
vi.mock('@/lib/native-ios-tab-bar', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/native-ios-tab-bar')>(),
  canUseNativeIosTabBar: () => true,
  getNativeIosTabBarPlugin: () => plugin,
  nativeIosTabBarAccentFromRoot: () => '',
}));
import { useNativeIosTabBar } from './useNativeIosTabBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  document.getElementById('mobile-overlay-root')?.remove();
});

test('forwards unread badge updates and explicit clearing across the native bridge', async () => {
  function Dock({ badge }: { badge: string | null }) {
    const mode = useNativeIosTabBar({ visible: true, activeTab: 'assistant', tabs: [{ id: 'assistant', label: 'Agent', badge }], ariaLabel: 'Navigation', onTabChange: () => undefined });
    return <output>{mode}</output>;
  }
  document.body.append(host);
  await act(async () => root.render(<Dock badge="99+" />));
  expect(plugin.present.mock.calls.at(-1)?.[0].tabs[0].badge).toBe('99+');
  expect(host.textContent).toBe('native');
  await act(async () => root.render(<Dock badge="4" />));
  expect(plugin.present.mock.calls.at(-1)?.[0].tabs[0].badge).toBe('4');
  await act(async () => root.render(<Dock badge={null} />));
  expect(plugin.present.mock.calls.at(-1)?.[0].tabs[0].badge).toBeNull();
  expect(plugin.present).toHaveBeenCalledTimes(3);
});
