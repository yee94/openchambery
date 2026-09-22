import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selected: 'openai', directory: '/workspace', generation: 0, listeners: new Set<() => void>(),
  list: vi.fn(), integrations: vi.fn(), connect: vi.fn(), status: vi.fn(), complete: vi.fn(), cancel: vi.fn(),
  key: vi.fn(), getIntegration: vi.fn(), removeCredential: vi.fn(),
  reload: vi.fn(), success: vi.fn(), error: vi.fn(), open: vi.fn(), select: vi.fn(),
}));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getSdkClient: () => ({
  provider: { list: state.list }, credential: { remove: state.removeCredential }, integration: { list: state.integrations, get: state.getIntegration, connect: { key: state.key }, oauth: {
    connect: state.connect, status: state.status, complete: state.complete, cancel: state.cancel,
  } },
}), getDirectory: () => state.directory } }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => `runtime-${state.generation}`,
  subscribeRuntimeEndpointChanged: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (s: unknown) => unknown) => select({
  providers: [{ id: 'openai', name: 'OpenAI', models: [] }], selectedProviderId: state.selected,
  setSelectedProvider: state.select, getModelMetadata: () => undefined,
}) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (s: unknown) => unknown) => select({ hiddenModels: {} }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (s: unknown) => unknown) => select({ currentDirectory: state.directory }) }));
vi.mock('@/stores/useAgentsStore', () => ({ reloadOpenCodeConfiguration: state.reload }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => new Response('{}') }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }), getCurrentIntlLocale: () => 'en' }));
function translate(key: string) { return key; }
vi.mock('@/lib/url', () => ({ openExternalUrl: state.open }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));
vi.mock('@/components/ui', () => ({ toast: { success: state.success, error: state.error, message: vi.fn() } }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./QuotaCredentials', () => ({ QuotaCredentials: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Box }));
vi.mock('@/components/sections/shared/SettingsGroup', () => ({ SettingsGroup: ({ children, label }: React.PropsWithChildren<{ label?: React.ReactNode }>) => <div>{label}{children}</div> }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: Box, TooltipContent: Box, TooltipTrigger: Box }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: Box, DropdownMenuContent: Box, DropdownMenuTrigger: Box,
  DropdownMenuItem: ({ children, onSelect }: React.PropsWithChildren<{ onSelect: () => void }>) => <button onClick={onSelect}>{children}</button>,
}));
function Box({ children }: React.PropsWithChildren) { return <div>{children}</div>; }
import { ProvidersPage } from './ProvidersPage';

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={cache}><ProvidersPage /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function start() {
  await mount();
  await click('settings.providers.page.actions.reconnect');
  await click('settings.providers.page.actions.connect');
}
async function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function saveKey() {
  await mount(); await click('settings.providers.page.actions.reconnect');
  await fill('input[type="password"]', 'fixture-key');
  await click('settings.providers.page.actions.saveKey');
}
async function changeScope(scope: 'directory' | 'runtime' | 'unmount') {
  if (scope === 'unmount') { await act(async () => root.render(null)); return; }
  if (scope === 'directory') state.directory = '/second-workspace';
  else state.generation++;
  await mount();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
  state.selected = 'openai'; state.generation = 0; state.directory = '/workspace';
  state.key.mockResolvedValue(undefined); state.removeCredential.mockResolvedValue(undefined);
  state.getIntegration.mockResolvedValue({ data: { connections: [{ type: 'credential', id: 'credential-1' }] } });
  state.list.mockResolvedValue({ data: [{ id: 'openai', integrationID: 'openai' }] });
  state.integrations.mockResolvedValue({ data: [
    { id: 'openai', name: 'OpenAI', connections: [{ type: 'credential', id: 'c1' }], methods: [{ id: 'browser', type: 'oauth', label: 'Browser OAuth' }] },
    { id: 'anthropic', name: 'Anthropic', connections: [], methods: [] },
    { id: 'mcp_remote', name: 'MCP remote', connections: [], methods: [] },
  ] });
  state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', mode: 'auto', url: 'https://example.com/authorize', instructions: 'Authorize in browser' } });
  state.status.mockResolvedValue({ data: { status: 'pending' } });
  state.cancel.mockResolvedValue(undefined); state.complete.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

describe('provider credential mutation scope regressions', () => {
  it('passes directory to key connect, refreshes only the current catalog, and selects the actual provider ID', async () => {
    state.directory = '/key-project'; state.selected = '__add_provider__';
    state.list.mockResolvedValue({ data: [] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [], methods: [] }] });
    const unrelated = ['runtime-0', 0, 'provider-connections', '/other-project'];
    cache.setQueryData(unrelated, { providers: [], integrations: [] });
    await mount(); await click('OpenAI integration');
    await fill('input[type="password"]', 'fixture-key');
    state.list.mockResolvedValue({ data: [{ id: 'openai-activated', integrationID: 'openai-int' }] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [{ type: 'credential', id: 'new' }], methods: [] }] });
    await click('settings.providers.page.actions.saveKey');
    expect(state.key).toHaveBeenCalledWith(expect.objectContaining({ integrationID: 'openai-int', location: { directory: '/key-project' } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.select).toHaveBeenCalledWith('openai-activated');
    expect(state.integrations).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/key-project'])).toEqual(expect.objectContaining({ providers: [{ id: 'openai-activated', integrationID: 'openai-int' }] }));
    expect(cache.getQueryState(unrelated)?.isInvalidated).toBe(false);
    expect(state.reload).toHaveBeenCalledWith(expect.objectContaining({ queryDirectory: '/key-project', transportIdentity: 'runtime-0' }));
  });
  it('gets credential IDs in the captured directory and removes them through the global credential API, then refreshes the connection cache', async () => {
    state.directory = '/disconnect-project'; await mount();
    state.getIntegration.mockResolvedValue({ data: { connections: [{ type: 'credential', id: 'one' }, { type: 'credential', id: 'two' }] } });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai', name: 'OpenAI', connections: [], methods: [] }] });
    await click('settings.providers.page.actions.disconnect');
    expect(state.getIntegration).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: '/disconnect-project' } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.removeCredential).toHaveBeenCalledTimes(2);
    expect(state.removeCredential.mock.calls.map(([input]) => input)).toEqual([{ credentialID: 'one' }, { credentialID: 'two' }]);
    for (const [, options] of state.removeCredential.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(state.integrations).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/disconnect-project'])).toEqual(expect.objectContaining({ integrations: [{ id: 'openai', name: 'OpenAI', connections: [], methods: [] }] }));
    expect(state.success).toHaveBeenCalledWith('settings.providers.page.toast.providerDisconnected');
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards a late key success after %s changes', async (scope) => {
    let resolve!: () => void;
    state.key.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await saveKey(); await changeScope(scope);
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
    expect(state.key.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards a late credential removal after %s changes', async (scope) => {
    let resolve!: () => void;
    state.removeCredential.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await mount(); await click('settings.providers.page.actions.disconnect'); await changeScope(scope);
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
    expect(state.removeCredential.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('stops disconnect before credential removal when integration.get finishes in another runtime', async () => {
    let resolve!: (data: unknown) => void;
    state.getIntegration.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(); await click('settings.providers.page.actions.disconnect'); await changeScope('runtime');
    await act(async () => resolve({ data: { connections: [{ type: 'credential', id: 'old' }] } }));
    expect(state.removeCredential).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
  });
  it.each(['key', 'disconnect'] as const)('stops the %s completion chain when scope changes during configuration reload', async (kind) => {
    let resolve!: () => void;
    state.reload.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    if (kind === 'key') await saveKey();
    else { await mount(); await click('settings.providers.page.actions.disconnect'); }
    await changeScope('directory');
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
  });
  it.each(['key', 'disconnect'] as const)('discards %s success after switching runtime during connection Query refresh', async (kind) => {
    await mount();
    let resolve!: (data: unknown) => void;
    state.integrations.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    if (kind === 'key') {
      await click('settings.providers.page.actions.reconnect');
      await fill('input[type="password"]', 'fixture-key');
      await click('settings.providers.page.actions.saveKey');
    } else await click('settings.providers.page.actions.disconnect');
    expect(state.reload).toHaveBeenCalledTimes(1);
    await changeScope('runtime');
    await act(async () => resolve({ data: [] }));
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled(); expect(state.error).not.toHaveBeenCalled();
  });
  it.each(['key', 'disconnect'] as const)('ignores a late %s failure in another directory', async (kind) => {
    let reject!: (error: Error) => void;
    const mutation = kind === 'key' ? state.key : state.removeCredential;
    mutation.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    if (kind === 'key') await saveKey();
    else { await mount(); await click('settings.providers.page.actions.disconnect'); }
    await changeScope('directory');
    await act(async () => reject(new Error('late failure')));
    expect(state.error).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
  });
});

describe('provider directory propagation', () => {
  it('queries each directory separately and sends OAuth connect/status/cancel to the captured directory', async () => {
    state.directory = '/oauth-project'; await start();
    for (const method of [state.list, state.integrations, state.connect, state.status]) {
      expect(method.mock.calls[0][0].location).toEqual({ directory: '/oauth-project' });
    }
    await changeScope('directory');
    expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: '/oauth-project' } }));
    expect(state.integrations.mock.calls.at(-1)![0].location).toEqual({ directory: '/second-workspace' });
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/second-workspace'])).toBeDefined();
  });
  it('passes the captured directory to code completion', async () => {
    state.directory = '/code-project';
    state.connect.mockResolvedValue({ data: { attemptID: 'code-attempt', mode: 'code', url: '', instructions: '' } });
    await start(); await fill('input[placeholder="settings.providers.page.auth.pasteAuthorizationCodePlaceholder"]', 'fixture-code');
    await click('settings.providers.page.actions.complete');
    expect(state.complete.mock.calls[0][0].location).toEqual({ directory: '/code-project' });
  });
  it('discards OAuth status when the directory changes before the React cleanup runs', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    state.directory = '/second-workspace';
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
  });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); vi.useRealTimers(); });

describe('provider connection regressions', () => {
  it('offers disconnected integrations absent from active provider.list, excluding MCP and connected integrations', async () => {
    state.selected = '__add_provider__'; await mount();
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).not.toContain('MCP remote');
    expect(host.textContent).not.toContain('OpenAI');
  });
  it('polls auto attempts and refreshes only after authoritative completion', async () => {
    await start();
    expect(state.complete).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.status).toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.reload).toHaveBeenCalledTimes(1); expect(state.success).toHaveBeenCalledTimes(1);
  });
  it('cancels an attempt and ignores an in-flight completion', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await click('settings.common.actions.cancel');
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.reload).not.toHaveBeenCalled();
    expect(host.querySelector('input[readonly]')).toBeNull();
  });
  it('aborts polling and cancels upstream when unmounted', async () => {
    await start();
    const signal = state.status.mock.calls[0][1].signal as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(state.status).toHaveBeenCalledTimes(1);
  });
  it('retires old-runtime work without sending its attempt to the new runtime', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await act(async () => { state.generation++; state.listeners.forEach((fn) => fn()); });
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });
  it.each(['failed', 'expired'])('clears %s attempts and allows retry', async (status) => {
    state.status.mockResolvedValue({ data: { status, message: 'https://example.com/?token=private' } });
    await start();
    expect(state.error).toHaveBeenCalledWith('settings.providers.page.toast.oauthCompleteFailed');
    expect(state.reload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('private');
    expect(host.querySelector('input[readonly]')).toBeNull();
    expect([...host.querySelectorAll('button')].find((el) => el.textContent === 'settings.providers.page.actions.connect')?.disabled).toBe(false);
  });
  it('bounds waiting by server expiry and cancels a hung status request', async () => {
    state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', mode: 'auto', url: '', instructions: '', time: { created: Date.now(), expires: Date.now() + 2000 } } });
    state.status.mockImplementation(() => new Promise(() => undefined));
    await start();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.status.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('cleans up a connect response arriving after cancellation on unmount', async () => {
    let resolve!: (value: unknown) => void;
    state.connect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await act(async () => root.render(null));
    await act(async () => resolve({ data: { attemptID: 'late', mode: 'auto', url: '', instructions: '' } }));
    expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: 'late' }));
    expect(state.open).not.toHaveBeenCalled(); expect(state.status).not.toHaveBeenCalled();
  });
  it('submits complete only for a non-empty code attempt', async () => {
    state.connect.mockResolvedValue({ data: { attemptID: 'code-attempt', mode: 'code', url: '', instructions: 'Paste code' } });
    await start();
    expect(state.status).not.toHaveBeenCalled();
    await click('settings.providers.page.actions.complete');
    expect(state.complete).not.toHaveBeenCalled();
    const input = host.querySelector<HTMLInputElement>('input[placeholder="settings.providers.page.auth.pasteAuthorizationCodePlaceholder"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' test-code ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('settings.providers.page.actions.complete');
    expect(state.complete).toHaveBeenCalledWith(expect.objectContaining({ code: 'test-code', attemptID: 'code-attempt' }), expect.anything());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
  it('surfaces transport failure and clears waiting state', async () => {
    state.status.mockRejectedValue(new Error('https://example.com/?token=private'));
    await start();
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.reload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('private');
  });
  it('cancels when switching providers and ignores delayed status', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start(); state.selected = '__add_provider__'; await mount();
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).toHaveBeenCalledTimes(1); expect(state.reload).not.toHaveBeenCalled();
  });
  it('bounds a stalled connect request and supports restarting', async () => {
    state.connect.mockImplementation(() => new Promise(() => undefined));
    await start();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(state.error).toHaveBeenCalledWith('settings.providers.page.toast.oauthStartFailed');
    expect(state.connect.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('keeps the available snapshot when a refresh fails', async () => {
    state.selected = '__add_provider__'; await mount();
    expect(host.textContent).toContain('Anthropic');
    state.integrations.mockRejectedValue(new Error('offline'));
    await act(async () => { await cache.invalidateQueries(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('settings.providers.page.state.unableToLoadProviderList');
  });
  it('reports refresh failure after completion without claiming successful refresh', async () => {
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    state.reload.mockRejectedValue(new Error('offline'));
    await start();
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.success).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it('selects the activated provider ID after connecting an integration from add mode', async () => {
    state.selected = '__add_provider__';
    state.list.mockResolvedValue({ data: [] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [], methods: [{ id: 'browser', type: 'oauth' }] }] });
    await mount(); await click('OpenAI integration'); await click('settings.providers.page.actions.connect');
    state.list.mockResolvedValue({ data: [{ id: 'openai-activated', integrationID: 'openai-int' }] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [{ type: 'credential', id: 'new' }], methods: [] }] });
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.select).toHaveBeenCalledWith('openai-activated');
    expect(state.success).toHaveBeenCalledTimes(1);
  });
});
