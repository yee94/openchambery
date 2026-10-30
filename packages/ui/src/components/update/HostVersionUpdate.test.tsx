import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostVersionUpdate } from './HostVersionUpdate';
import { dict as en } from '@/lib/i18n/messages/en';
import { useUIStore } from '@/stores/useUIStore';
import { hostUpdateQueryOptions } from '@/queries/hostUpdateQueries';

const fixture = vi.hoisted(() => ({ transport: 'host-a', generation: 1, fetch: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: fixture.success, error: fixture.error, info: fixture.info } }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => fixture.transport, getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: keyof typeof en) => en[key] ?? key }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const snapshot = () => ({ serverId: 'server-a', host: 'electron', currentVersion: '2.0.0', channel: 'stable', supported: true, reason: null, checkError: null,
  update: { version: '2.0.1', kind: 'ota', releaseNotes: 'Important fixes', planId: 'plan-a', rollback: false, restartRequired: true }, operation: null });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.transport = 'host-a'; fixture.generation = 1;
  fixture.success.mockReset();
  fixture.error.mockReset();
  fixture.info.mockReset();
  useUIStore.setState({ otaChannelOverride: null });
  fixture.fetch.mockReset().mockImplementation(async (_path: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ operation: { id: 'op-a', version: '2.0.1', channel: 'stable', status: 'downloading', progress: 5 } }, { status: 202 })
    : Response.json(snapshot()));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><HostVersionUpdate version="2.0.0" transport="host-a" generation={1} /></QueryClientProvider>); await settle(); });
  await act(settle);
}
async function open() {
  await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await settle(); });
  await act(settle);
}

it('shows a red update dot and confirms the exact version and plan through the active runtime transport', async () => {
  await render();
  const dot = host.querySelector('[aria-label="Update available"]');
  expect(dot).not.toBeNull();
  expect(dot?.parentElement?.textContent).toBe('2.0.0');
  expect(dot?.closest('button')).toBeNull();
  await open();
  expect(document.body.querySelector('[role="dialog"] [role="checkbox"]')).toBeNull();
  expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(document.body.textContent).toContain('Important fixes');
  expect(document.body.textContent).not.toContain('OTA update');
  expect(document.body.textContent).toContain(en['updateDialog.changelog.title']);
  const button = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart');
  expect(button?.disabled).toBe(false);
  const actions = button?.parentElement;
  expect(actions?.classList.contains('flex-nowrap')).toBe(true);
  expect(actions?.classList.contains('min-w-0')).toBe(true);
  expect(actions?.children).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Check updates');
  expect(actions?.previousElementSibling).toBeNull();
  for (const action of Array.from(actions?.children ?? [])) {
    expect(action.classList.contains('shrink')).toBe(true);
    expect(action.querySelector('.truncate')?.textContent).toBe(action.getAttribute('title'));
  }
  await act(async () => { button?.click(); await settle(); });
  const submission = fixture.fetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(submission?.[1].body)).toEqual({ version: '2.0.1', channel: 'stable', planId: 'plan-a', allowDowngrade: false });
});

it('shows the ongoing task instead of starting another update, including reconnect failures', async () => {
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation: { id: 'op', version: '2.0.1', status: 'restarting', progress: 100 } }));
  await render(); await open();
  expect(document.body.textContent).toContain('Restarting');
  expect(document.body.textContent).not.toContain('Check updates');
  expect(document.body.textContent).not.toContain('Update and restart');
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(document.body.textContent).toContain('Waiting for the Host to reconnect');
  expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('keeps reconnecting through the restart gap, then closes and notifies once on confirmed success', async () => {
  const restarting = { id: 'op', version: '2.0.1', status: 'restarting', progress: 100 };
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation: restarting }));
  await render(); await open();
  fixture.fetch.mockImplementation(async () => new Response('', { status: 404 }));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(document.body.textContent).toContain('Waiting for the Host to reconnect');
  expect(document.body.textContent).not.toContain(en['settings.yuri.about.hostUpdate.unsupported']);
  expect(fixture.success).not.toHaveBeenCalled();
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), currentVersion: '2.0.1', update: null, operation: { ...restarting, status: 'succeeded' } }));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.hostUpdate.status.succeeded'], expect.objectContaining({ id: 'host-update:host-a:1:op' }));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(fixture.success).toHaveBeenCalledTimes(1);
  const beforeCheck = fixture.fetch.mock.calls.length;
  await open();
  expect(fixture.fetch.mock.calls.length).toBe(beforeCheck + 1);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).toHaveBeenLastCalledWith(en['settings.yuri.about.toast.latestVersion']);
  expect(fixture.success).toHaveBeenCalledTimes(2);
});

it('checks historical success again and only notifies latest-version on an explicit click', async () => {
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation: { id: 'old-op', version: '2.0.1', status: 'succeeded', progress: 100 } }));
  await render();
  expect(fixture.success).not.toHaveBeenCalled();
  const beforeCheck = fixture.fetch.mock.calls.length;
  await open();
  expect(fixture.fetch.mock.calls.length).toBe(beforeCheck + 1);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.toast.latestVersion']);
});

it('keeps a failed update visible without a success notification', async () => {
  const operation = { id: 'op', version: '2.0.1', status: 'restarting', progress: 100 };
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation }));
  await render(); await open();
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation: { ...operation, status: 'failed' } }));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(en['settings.yuri.about.hostUpdate.status.failed']);
  expect(document.body.textContent).not.toContain('Check updates');
  expect(fixture.success).not.toHaveBeenCalled();
});

it('ignores an old Host success after the runtime changes', async () => {
  const operation = { id: 'op', version: '2.0.1', status: 'restarting', progress: 100 };
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation }));
  await render(); await open();
  fixture.transport = 'host-b'; fixture.generation++;
  await act(async () => {
    client.setQueryData(hostUpdateQueryOptions('host-a', 1).queryKey, { ...snapshot(), update: null, operation: { ...operation, status: 'succeeded' } });
    await settle();
  });
  expect(fixture.success).not.toHaveBeenCalled();
});

it('replaces actions with compact progress while retaining the changelog and frame through reconnect', async () => {
  await render(); await open();
  const dialog = document.body.querySelector('[role="dialog"]');
  const frameClass = dialog?.className;
  const changelog = dialog?.querySelector('section');
  expect(frameClass).toContain('h-[min(38rem,calc(100dvh-2rem))]');
  expect(frameClass).toContain('transition-[opacity,transform,filter]');
  expect(changelog?.textContent).toContain('Important fixes');
  expect(dialog?.querySelector('[role="status"]')).toBeNull();
  expect(changelog?.nextElementSibling).toBeNull();
  let accept: ((response: Response) => void) | undefined;
  const operation = { id: 'op', planId: 'plan-a', version: '2.0.1', channel: 'stable', kind: 'ota', status: 'checking', progress: null };
  fixture.fetch.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>((resolve) => { accept = resolve; })
    : Response.json({ ...snapshot(), update: null, operation }));
  const confirm = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart');
  await act(async () => { confirm?.click(); await settle(); });
  expect(dialog?.querySelector('section')).toBe(changelog);
  expect(changelog?.textContent).toContain('Important fixes');
  const progressSlot = dialog?.querySelector('[role="status"]');
  expect(progressSlot).not.toBeNull();
  expect(progressSlot?.querySelector('p')).toBeNull();
  expect(dialog?.querySelectorAll('button')).toHaveLength(1);
  expect(dialog?.textContent).not.toContain('Check updates');
  expect(dialog?.textContent).not.toContain('Update and restart');
  await act(async () => { accept?.(Response.json({ operation }, { status: 202 })); await settle(); });
  for (const status of ['checking', 'downloading', 'installing', 'restarting']) {
    fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null, operation: { ...operation, status } }));
    await act(async () => { await client.invalidateQueries(); await settle(); });
    expect(dialog?.className).toBe(frameClass);
    expect(dialog?.querySelector('section')).toBe(changelog);
    expect(changelog?.textContent).toContain('Important fixes');
    expect(changelog?.nextElementSibling).toBe(progressSlot);
    expect(dialog?.querySelectorAll('button')).toHaveLength(1);
    expect(progressSlot?.querySelector('p')).toBeNull();
  }
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(dialog?.className).toBe(frameClass);
  expect(changelog?.textContent).toContain('Important fixes');
  expect(document.body.textContent).toContain('Waiting for the Host to reconnect');
  expect(changelog?.nextElementSibling).toBe(progressSlot);
  expect(progressSlot?.querySelector('p')).toBeNull();
});

it('does not reuse another channel’s retained changelog', async () => {
  useUIStore.setState({ otaChannelOverride: 'stable' });
  await render(); await open();
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), channel: 'beta', update: null, operation: { id: 'op', planId: 'plan-a', version: '2.0.1', channel: 'beta', kind: 'ota', status: 'downloading', progress: 20 } }));
  await act(async () => { useUIStore.setState({ otaChannelOverride: 'beta' }); await settle(); });
  await act(settle);
  expect(document.body.textContent).not.toContain('Important fixes');
  expect(document.body.textContent).toContain(en['settings.yuri.about.hostUpdate.noNotes']);
});

it('fails a stranded status request instead of pinning the poll forever', async () => {
  vi.useFakeTimers();
  try {
    fixture.fetch.mockImplementation(() => new Promise(() => {}));
    const result = client.fetchQuery(hostUpdateQueryOptions('host-a', 1));
    const assertion = expect(result).rejects.toThrow('host_update_timeout');
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  } finally { vi.useRealTimers(); }
});

it('keeps a good version snapshot but does not open an old plan after a failed check', async () => {
  await render();
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await open();
  expect(host.textContent).toContain('2.0.0');
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.error).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.toast.checkFailed']);
  expect(fixture.success).not.toHaveBeenCalled();
});

it('does not open a cached update or notify until the manual check resolves', async () => {
  await render();
  let resolve: ((response: Response) => void) | undefined;
  fixture.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  const beforeCheck = fixture.fetch.mock.calls.length;
  await open();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).not.toHaveBeenCalled();
  await open();
  expect(fixture.fetch.mock.calls.length).toBe(beforeCheck + 1);
  await act(async () => { resolve?.(Response.json({ ...snapshot(), update: null })); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.toast.latestVersion']);
});

it.each(['check-error', 'unsupported'] as const)('keeps %s distinct from a confirmed latest version', async (result) => {
  await render();
  fixture.fetch.mockImplementation(async () => Response.json({ ...snapshot(), update: null,
    supported: result !== 'unsupported', checkError: result === 'check-error' ? 'update_check_failed' : null,
  }, { status: result === 'check-error' ? 502 : 200 }));
  await open();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).not.toHaveBeenCalled();
  if (result === 'unsupported') expect(fixture.info).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.hostUpdate.unsupported']);
  else expect(fixture.error).toHaveBeenCalledExactlyOnceWith(en['settings.yuri.about.toast.checkFailed']);
});

it('does not open or notify from a manual check that finishes after a runtime switch', async () => {
  await render();
  let resolve: ((response: Response) => void) | undefined;
  fixture.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  await open();
  fixture.transport = 'host-b'; fixture.generation++;
  await act(async () => { resolve?.(Response.json(snapshot())); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.error).not.toHaveBeenCalled();
});

it('ignores a manual beta check that finishes after switching to stable', async () => {
  useUIStore.setState({ otaChannelOverride: 'beta' });
  await render();
  let resolve: ((response: Response) => void) | undefined;
  fixture.fetch.mockImplementation(async (path: string) => path.includes('channel=beta')
    ? new Promise<Response>((done) => { resolve = done; })
    : Response.json({ ...snapshot(), update: null }));
  await open();
  await act(async () => { useUIStore.setState({ otaChannelOverride: 'stable' }); await settle(); });
  await act(async () => { resolve?.(Response.json({ ...snapshot(), channel: 'beta' })); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.error).not.toHaveBeenCalled();
});

it('keeps an open plan visible but blocks confirmation after a background check fails', async () => {
  await render(); await open();
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await client.invalidateQueries(); await settle(); });
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(en['settings.yuri.about.toast.checkFailed']);
  expect(Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart')?.disabled).toBe(true);
  expect(fixture.success).not.toHaveBeenCalled();
});

it('never submits an old Host plan after a runtime switch', async () => {
  await render(); await open();
  fixture.transport = 'host-b'; fixture.generation++;
  await act(async () => { Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart')?.click(); await settle(); });
  expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('follows the outer beta switch for discovery and exact-plan submission without another dialog checkbox', async () => {
  useUIStore.setState({ otaChannelOverride: 'beta' });
  fixture.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ operation: { id: 'op' } }, { status: 202 });
    const beta = path.includes('channel=beta');
    return Response.json({ ...snapshot(), channel: beta ? 'beta' : 'stable', update: { ...snapshot().update,
      version: beta ? '2.1.0-beta.1' : '2.0.1', planId: beta ? 'beta-plan' : 'stable-plan' } });
  });
  await render(); await open();
  expect(fixture.fetch.mock.calls.some(([path]) => path === '/api/system/update?channel=beta')).toBe(true);
  expect(document.body.textContent).toContain('2.1.0-beta.1');
  expect(document.body.querySelector('[role="dialog"] [role="checkbox"]')).toBeNull();
  await act(async () => { useUIStore.setState({ otaChannelOverride: 'stable' }); await settle(); });
  await act(settle);
  expect(document.body.textContent).not.toContain('2.1.0-beta.1');
  const confirm = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart');
  await act(async () => { confirm?.click(); await settle(); });
  const submission = fixture.fetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(submission?.[1].body)).toMatchObject({ channel: 'stable', version: '2.0.1', planId: 'stable-plan' });
});

it('keeps an in-flight mutation bound to its original channel when the outer switch changes', async () => {
  useUIStore.setState({ otaChannelOverride: 'beta' });
  let accept: ((response: Response) => void) | undefined;
  fixture.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { accept = resolve; });
    return Response.json({ ...snapshot(), channel: path.includes('channel=beta') ? 'beta' : 'stable' });
  });
  await render(); await open();
  const confirm = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === 'Update and restart');
  await act(async () => { confirm?.click(); await settle(); });
  await act(async () => { useUIStore.setState({ otaChannelOverride: 'stable' }); await settle(); });
  await act(async () => { accept?.(Response.json({ operation: { id: 'beta-operation', status: 'downloading' } }, { status: 202 })); await settle(); });
  const stable = client.getQueryData<{ operation: unknown }>(hostUpdateQueryOptions('host-a', 1, 'stable').queryKey);
  const beta = client.getQueryData<{ operation: { id: string } }>(hostUpdateQueryOptions('host-a', 1, 'beta').queryKey);
  expect(stable?.operation).toBeNull();
  expect(beta?.operation.id).toBe('beta-operation');
});
