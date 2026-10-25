import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadMobileConnections, useMobileConnection, type UseMobileConnection } from './mobileConnections';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => '', getRuntimeKey: () => 'test', switchRuntimeEndpoint: vi.fn(),
}));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => false }));
vi.mock('./MobileShareBridge', () => ({ publishNativeAssistantCatalog: vi.fn().mockResolvedValue(undefined) }));

const key = 'yuri.mobile.connections.v1';
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let controller: UseMobileConnection;
const connected = vi.fn();
const records = [
  { id: 'z', label: 'Recent', candidates: [{ kind: 'direct', url: 'https://recent.example' }], lastUsedAt: 200 },
  { id: 'a', label: 'Older', candidates: [{ kind: 'direct', url: 'https://older.example' }], lastUsedAt: 100 },
];
function Harness() { controller = useMobileConnection(connected); return null; }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.setItem(key, JSON.stringify(records));
  connected.mockClear();
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); localStorage.removeItem(key);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test('rename persists only the label, preserving order and transport metadata', async () => {
  await act(async () => { await controller.renameConnection('a', ' Renamed '); });
  expect(controller.connections.map((item) => item.id)).toEqual(['z', 'a']);
  expect(controller.connections[1]).toMatchObject({ ...records[1], label: 'Renamed' });
  expect((await loadMobileConnections())[1]).toMatchObject({ ...records[1], label: 'Renamed' });
});

test('metadata save and password challenge do not count as a successful connection', async () => {
  await act(async () => { await controller.saveConnection({ id: 'a', label: 'Saved', url: 'https://older.example' }); });
  expect(controller.connections.map((item) => item.lastUsedAt)).toEqual([200, 100]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('{}', { status: url.endsWith('/auth/session') ? 401 : 200 })));
  await act(async () => { await controller.connect({ id: 'a', candidates: controller.connections[1].candidates }); });
  expect(controller.pendingConnection?.id).toBe('a');
  expect(controller.connections.map((item) => item.lastUsedAt)).toEqual([200, 100]);
  expect(connected).not.toHaveBeenCalled();
});

test('only a successful retry moves the selected device ahead of unrelated devices', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await act(async () => { await controller.connect({ id: 'a', candidates: controller.connections[1].candidates }); });
  expect(controller.connections.map((item) => item.id)).toEqual(['z', 'a']);
  expect(controller.error).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: true, disabled: true }), { status: 200 })));
  await act(async () => { await controller.connect({ id: 'a', candidates: controller.connections[1].candidates }); });
  expect(controller.connections.map((item) => item.id)).toEqual(['a', 'z']);
  expect(controller.connections[0].lastUsedAt).toBeGreaterThan(200);
  expect(controller.error).toBeNull();
  expect(connected).toHaveBeenCalledTimes(1);
});

test('failed metadata writes retain the authoritative list and expose a retryable error', async () => {
  const before = controller.connections;
  const storage = window.localStorage;
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
    getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
    clear: storage.clear.bind(storage), key: storage.key.bind(storage), length: storage.length,
    setItem: () => { throw new Error('quota'); },
  });
  await act(async () => { expect(await controller.renameConnection('a', 'Unsaved')).toBeNull(); });
  expect(controller.connections).toBe(before);
  expect(controller.error).toBe('mobile.connect.history.updateFailed');
  await act(async () => { expect(await controller.removeConnection('a')).toBeNull(); });
  expect(controller.connections).toBe(before);
  expect(controller.isBusy).toBe(false);
});

test('removing one or the last device updates the list and durable storage', async () => {
  await act(async () => { await controller.removeConnection('a'); });
  expect(controller.connections.map((item) => item.id)).toEqual(['z']);
  await act(async () => { await controller.removeConnection('z'); });
  expect(controller.connections).toEqual([]);
  expect(await loadMobileConnections()).toEqual([]);
});

test('a concurrent connection cannot override an in-flight attempt', async () => {
  let release!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockResolvedValue(new Response(JSON.stringify({ authenticated: true, disabled: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    const first = controller.connect({ id: 'z', candidates: controller.connections[0].candidates });
    await controller.connect({ id: 'a', candidates: controller.connections[1].candidates });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release(new Response('{}', { status: 200 }));
    await first;
  });
  expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://recent.example'))).toBe(true);
  expect(connected).toHaveBeenCalledTimes(1);
});
