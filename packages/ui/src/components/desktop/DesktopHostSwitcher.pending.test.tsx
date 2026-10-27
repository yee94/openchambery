import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openWindow: vi.fn(), switchHost: vi.fn(), close: vi.fn(), busy: vi.fn(), error: vi.fn(),
  t: (key: string, params?: Record<string, string>) => `${key}${params?.instance ? `:${params.instance}` : ''}`,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => true, isDesktopShell: () => true }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: object) => unknown) => select({ setSettingsDialogOpen() {}, setSettingsPage() {} }) }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: object) => unknown) => select({ isConnected: true, connectionPhase: 'connected' }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'local', getRuntimeApiBaseUrl: () => 'http://localhost:3000',
  getRuntimeTransportIdentity: () => 'direct:local', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/desktopHostSwitch', () => ({ runtimeKeyForDesktopHost: (host: { id: string }) => host.id === 'local' ? 'local' : `host:${host.id}` }));
vi.mock('@/queries/desktopHostSwitchMutation', () => ({
  switchDesktopHostInstance: mocks.switchHost, useDesktopHostSwitchPending: () => false,
  useDesktopHostSwitchingHostId: () => null,
}));
vi.mock('@/lib/desktopHosts', () => ({
  desktopHostsGet: async () => ({ hosts: [{ id: 'ssh', label: 'SSH fixture', url: 'http://localhost:4000' }], localOrigin: 'http://localhost:3000' }),
  desktopHostProbe: async () => ({ status: 'ok', latencyMs: 1 }),
  desktopLocalClientTokenGet: async () => '',
  desktopOpenNewWindowAtUrl: mocks.openWindow, desktopOpenNewWindowForHost: mocks.openWindow,
  getDesktopHostApiUrl: (host: { url: string }) => host.url,
  isVisibleDesktopHost: () => true, locationMatchesHost: () => false,
  normalizeHostUrl: (url: string) => url, redactSensitiveUrl: (url: string) => url,
}));
vi.mock('@/lib/desktopSsh', () => ({
  desktopSshInstancesGet: async () => ({ instances: [{ id: 'ssh' }] }),
  desktopSshStatus: async () => [{ id: 'ssh', phase: 'ready' }],
}));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./SshBootstrapErrorNotice', () => ({ SshBootstrapErrorNotice: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: () => null, DialogHeader: () => null, DialogTitle: () => null,
}));

import { DesktopHostSwitcherDialog } from './DesktopHostSwitcher';

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DesktopHostSwitcherDialog embedded open onOpenChange={mocks.close} onHostSwitched={mocks.close} onBusyChange={mocks.busy} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const switchButton = () => container.querySelector<HTMLButtonElement>('[aria-label="desktopHostSwitcher.actions.switchToAria:SSH fixture"]')!;
const windowButton = () => switchButton().parentElement!.querySelector<HTMLButtonElement>('[aria-label="desktopHostSwitcher.actions.openInNewWindowAria"]')!;

it('keeps the popup open and disables both actions until new-window preparation finishes', async () => {
  let finish!: () => void;
  mocks.openWindow.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => {
    windowButton().click();
    windowButton().click();
  });
  expect(mocks.openWindow).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.busy).toHaveBeenLastCalledWith(true);
  expect(windowButton().disabled).toBe(true);
  expect(switchButton().disabled).toBe(true);
  await act(async () => { finish(); });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.busy).toHaveBeenLastCalledWith(false);
});

it('keeps failed updates open and enables retry', async () => {
  mocks.openWindow.mockRejectedValue(new Error('Update failed'));
  await act(async () => windowButton().click());
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledOnce();
  expect(windowButton().disabled).toBe(false);
  expect(switchButton().disabled).toBe(false);
  expect(mocks.busy).toHaveBeenLastCalledWith(false);
});

it('uses inline switch progress and blocks repeated switch/window clicks', async () => {
  let finish!: (value: object) => void;
  mocks.switchHost.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => {
    switchButton().click();
    switchButton().click();
    windowButton().click();
  });
  expect(mocks.switchHost).toHaveBeenCalledOnce();
  expect(mocks.switchHost).toHaveBeenCalledWith(expect.objectContaining({ inlineProgress: true }));
  expect(mocks.openWindow).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(windowButton().disabled).toBe(true);
  expect(switchButton().disabled).toBe(true);
  await act(async () => { finish({ ok: true, status: { status: 'ok', latencyMs: 1 } }); });
  expect(mocks.close).toHaveBeenCalledOnce();
});
