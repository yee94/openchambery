import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, test, vi } from 'vitest';
import { OpenInAppButton } from './OpenInAppButton';

const io = vi.hoisted(() => ({
  local: false,
  ssh: null as null | { hostId: string; appIds: string[] },
  apps: [{ id: 'finder', appName: 'Finder', label: 'Finder' }, { id: 'cursor', appName: 'Cursor', label: 'Cursor' }],
  open: vi.fn(), fallback: vi.fn(), copy: vi.fn(), error: vi.fn(), select: vi.fn(),
}));
vi.mock('@/lib/desktop', () => ({
  isDesktopLocalOriginActive: () => io.local, isDesktopShell: () => true,
  openDesktopProjectInApp: io.open, openDesktopPath: io.fallback,
}));
vi.mock('@/queries/sshEditorQueries', () => ({ useSshEditorQuery: () => ({ data: io.ssh }) }));
vi.mock('@/stores/useOpenInAppsStore', () => ({
  useOpenInAppsStore: (selector: (state: unknown) => unknown) => selector({
    availableApps: io.apps, selectedAppId: 'finder', initialize: () => {}, selectApp: io.select,
  }),
}));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: io.copy }));
vi.mock('@/components/ui', () => ({ toast: { error: io.error } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: { app: string }) => `${key}${params?.app ?? ''}` }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => <button onClick={onClick}>{children}</button>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  io.local = false;
  io.ssh = { hostId: 'ssh-a', appIds: ['cursor'] };
  io.open.mockResolvedValue(true);
});

const fixture = async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => act(async () => root.render(<OpenInAppButton directory="/srv/remote project" />));
  await render();
  return { host, render, close: () => act(async () => root.unmount()) };
};

test('SSH filters local-only apps and passes remote host identity; copy remains a plain remote path', async () => {
  const view = await fixture();
  try {
    expect(view.host.textContent).not.toContain('Finder');
    expect(view.host.textContent).toContain('Cursor');
    await act(async () => view.host.querySelector('button')!.click());
    expect(io.open).toHaveBeenCalledWith('/srv/remote project', 'cursor', 'Cursor', 'ssh-a');
    const copy = [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'openInApp.actions.copyPath')!;
    await act(async () => copy.click());
    expect(io.copy).toHaveBeenCalledWith('/srv/remote project');
    expect(io.fallback).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

test('no compatible installed editor still leaves a working copy button', async () => {
  io.ssh!.appIds = [];
  const view = await fixture();
  try {
    await act(async () => view.host.querySelector('button')!.click());
    expect(io.copy).toHaveBeenCalledWith('/srv/remote project');
    expect(io.open).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

test('failed SSH launches report failure without opening the remote path locally', async () => {
  io.open.mockRejectedValueOnce(new Error('SSH_EDITOR_CONFIG_REQUIRED'));
  const view = await fixture();
  try {
    await act(async () => view.host.querySelector('button')!.click());
    expect(io.error).toHaveBeenCalledWith('openInApp.errors.sshConfigRequiredCursor');
    expect(io.fallback).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

test('switching to ordinary Relay hides toolbar; switching local restores local apps', async () => {
  const view = await fixture();
  try {
    io.ssh = null;
    await view.render();
    expect(view.host.textContent).toBe('');
    io.local = true;
    await view.render();
    expect(view.host.textContent).toContain('Finder');
    await act(async () => view.host.querySelector('button')!.click());
    expect(io.open).toHaveBeenCalledWith('/srv/remote project', 'finder', 'Finder', undefined);
  } finally { await view.close(); }
});
