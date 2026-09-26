import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenCodeUpdateToast } from './OpenCodeUpdateToast';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), transport: 'host-a', listeners: new Set<() => void>(),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => fixture.transport,
  getRuntimeGeneration: () => 1,
  subscribeRuntimeEndpointChanged: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn); },
}));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign(() => true, { getState: () => ({ showOpenCodeUpdateNotifications: true }) }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/toast', () => ({ toast: fixture.toast }));
vi.mock('@/stores/utils/safeStorage', () => ({ getDeferredSafeStorage: () => ({ getItem: () => null, setItem: vi.fn() }) }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.transport = 'host-a';
  fixture.listeners.clear();
  fixture.fetch.mockImplementation(async (_path: string, options?: RequestInit) => Response.json(options?.method === 'POST'
    ? { success: true, restarted: true, version: '2.0.18' }
    : { available: true, canManage: true, targetVersion: '2.0.18' }));
  host = document.createElement('div');
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.useRealTimers();
});
const mount = async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><OpenCodeUpdateToast /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
};

it('offers the remote release and one click installs it without a second reload', async () => {
  await mount();
  expect(fixture.toast.info).toHaveBeenCalled();
  await act(async () => fixture.toast.info.mock.calls.at(-1)![1].action.onClick());
  expect(fixture.fetch.mock.calls.find(([, options]) => options?.method === 'POST')?.[1].body)
    .toBe(JSON.stringify({ target: '2.0.18', confirmActiveTasks: false }));
  expect(fixture.toast.success).toHaveBeenCalled();
  expect(fixture.toast.success.mock.calls[0][1].action).toBeUndefined();
});

it('rechecks after a host switch and prevents an old toast from upgrading the new host', async () => {
  await mount();
  const oldAction = fixture.toast.info.mock.calls.at(-1)![1].action.onClick;
  await act(async () => { fixture.transport = 'host-b'; fixture.listeners.forEach((fn) => fn()); });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await act(async () => oldAction());
  expect(fixture.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  expect(fixture.toast.info).toHaveBeenCalledTimes(2);
});

it('rechecks while open so an initial failed check does not hide later updates', async () => {
  fixture.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(fixture.toast.info).toHaveBeenCalled();
});

it('lets an active-task rejection be explicitly confirmed and retried', async () => {
  await mount();
  fixture.fetch.mockResolvedValueOnce(Response.json({ success: false, errorCode: 'UPGRADE_ACTIVE_TASKS', error: 'Confirm interruption' }, { status: 409 }));
  await act(async () => fixture.toast.info.mock.calls.at(-1)![1].action.onClick());
  expect(fixture.toast.success).not.toHaveBeenCalled();
  await act(async () => fixture.toast.error.mock.calls.at(-1)![1].action.onClick());
  const posts = fixture.fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(JSON.parse(posts.at(-1)![1].body).confirmActiveTasks).toBe(true);
  expect(fixture.toast.success).toHaveBeenCalled();
});
