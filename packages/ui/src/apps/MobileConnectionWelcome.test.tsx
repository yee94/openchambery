import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { MobileConnectionWelcome } from './MobileConnectionWelcome';
import type { UseMobileConnection } from './mobileConnections';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }), minimizeApp: vi.fn() } }));
vi.mock('./mobileQrScan', async (original) => ({ ...await original<typeof import('./mobileQrScan')>(), isQrScanSupported: () => true }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let conn: UseMobileConnection;
const saved = [
  { id: 'z', label: 'Recent device', candidates: [{ kind: 'direct' as const, url: 'https://recent.example' }], lastUsedAt: 200 },
  { id: 'a', label: 'Older device', candidates: [{ kind: 'direct' as const, url: 'https://older.example' }], lastUsedAt: 100 },
];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  conn = {
    connections: [], isBusy: false, isPasswordBusy: false, error: null, pendingConnection: null,
    connect: vi.fn().mockResolvedValue(undefined), redeemPairingConnection: vi.fn().mockResolvedValue(undefined),
    submitPassword: vi.fn().mockResolvedValue(undefined), cancelPassword: vi.fn(),
    saveConnection: vi.fn().mockResolvedValue(null), renameConnection: vi.fn().mockResolvedValue(null), removeConnection: vi.fn().mockResolvedValue(null),
    subscribeConnected: vi.fn(() => () => {}), setError: vi.fn(),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); document.getElementById('mobile-overlay-root')?.remove();
  vi.restoreAllMocks();
});
const render = async () => { await act(async () => root.render(<MobileConnectionWelcome connection={{ ...conn }} />)); };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!;
const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };

test('first launch keeps forms off the welcome page and opens the shared options sheet', async () => {
  await render();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('header [role="img"][aria-label="Yuri"]')).not.toBeNull();
  expect(host.textContent).not.toContain('mobile.connect.history.welcomeBack');
  await click(button('mobile.connect.welcome.moreOptions'));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('input[aria-label="mobile.connect.link.label"]')).not.toBeNull();
  expect(button('mobile.connect.connectButton').disabled).toBe(true);
  expect(host.querySelector('[data-welcome-paused]')).not.toBeNull();
});

test('recent device is the primary action without presenting stored history as online', async () => {
  conn.connections = saved; await render();
  expect(host.textContent).toContain('Recent device');
  expect(host.textContent).not.toContain('Older device');
  expect(host.textContent).not.toContain('mobile.instances.status.connected');
  await click(button('mobile.connect.history.continue'));
  expect(conn.connect).toHaveBeenCalledWith({ id: 'z', candidates: saved[0].candidates, label: 'Recent device' });
});

test('pasting is explicit, never connects automatically, and retains invalid input across sheet reopen', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('not-a-pairing-link');
  await render(); await click(button('mobile.connect.welcome.moreOptions'));
  await click(document.querySelector<HTMLElement>('[aria-label="mobile.connect.link.paste"]')!);
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('not-a-pairing-link');
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(conn.setError).toHaveBeenCalledWith('mobile.connect.link.invalid');
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
  await click(document.querySelector<HTMLElement>('[aria-label="mobile.surface.closeAria"]')!);
  await click(button('mobile.connect.welcome.moreOptions'));
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('not-a-pairing-link');
});

test('history connects only the tapped device and marks only its row busy or failed', async () => {
  conn.connections = saved; await render();
  await click(host.querySelector<HTMLElement>('.yuri-welcome-device')!);
  const row = [...document.querySelectorAll<HTMLButtonElement>('.yuri-welcome-history-row')].find((item) => item.textContent?.includes('Older device'))!;
  await click(row);
  expect(conn.connect).toHaveBeenCalledWith({ id: 'a', candidates: saved[1].candidates, label: 'Older device' });
  conn.isBusy = true; await render();
  expect(row.textContent).toContain('mobile.connect.connecting');
  const recent = [...document.querySelectorAll('.yuri-welcome-history-row')].find((item) => item.textContent?.includes('Recent device'))!;
  expect(recent.textContent).not.toContain('mobile.connect.connecting');
  conn.isBusy = false; conn.error = 'offline'; await render();
  expect(row.textContent).toContain('mobile.connect.history.failed');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('offline');
  await click(button('desktopHostSwitcher.actions.retry'));
  expect(conn.connect).toHaveBeenCalledTimes(2);
});

test('password challenge uses the same sheet and keeps the history page beneath it', async () => {
  conn.connections = saved; await render();
  await click(host.querySelector<HTMLElement>('.yuri-welcome-device')!);
  conn.pendingConnection = saved[0]; await render();
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(document.querySelector('[data-yuri-motion-id="welcome-history"]')).not.toBeNull();
  await click(button('mobile.connect.cancelPassword'));
  expect(conn.cancelPassword).toHaveBeenCalledTimes(1);
});

test('clipboard denial leaves manual entry available without starting a connection', async () => {
  vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('denied'));
  await render(); await click(button('mobile.connect.welcome.moreOptions'));
  await click(document.querySelector<HTMLElement>('[aria-label="mobile.connect.link.paste"]')!);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('mobile.connect.link.pasteFallback');
  expect(document.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
  expect(conn.redeemPairingConnection).not.toHaveBeenCalled();
});

test('shared history menu opens rename and local-removal confirmation without connecting', async () => {
  conn.connections = [saved[0]];
  vi.mocked(conn.renameConnection).mockResolvedValue(saved[0]);
  vi.mocked(conn.removeConnection).mockResolvedValue(saved[0]);
  await render(); await click(host.querySelector<HTMLElement>('.yuri-welcome-device')!);
  const openMenu = async () => {
    const trigger = document.querySelector<HTMLElement>('[aria-label="mobile.connect.history.actions"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
      trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      trigger.click();
    });
  };
  const menuItem = (key: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === key)!;
  await openMenu(); await click(menuItem('mobile.connect.history.rename'));
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('Recent device');
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(conn.renameConnection).toHaveBeenCalledWith('z', 'Recent device');
  await openMenu(); await click(menuItem('mobile.connect.history.remove'));
  expect(conn.removeConnection).not.toHaveBeenCalled();
  await click(button('mobile.connect.history.remove'));
  expect(conn.removeConnection).toHaveBeenCalledWith('z');
  expect(conn.connect).not.toHaveBeenCalled();
  conn.connections = []; await render();
  expect(document.body.textContent).toContain('mobile.connect.saved.empty');
  await click(document.querySelector<HTMLElement>('[aria-label="header.actions.backAria"]')!);
  expect(host.textContent).toContain('mobile.connect.welcome.heading');
  expect(host.textContent).not.toContain('mobile.connect.history.welcomeBack');
});
