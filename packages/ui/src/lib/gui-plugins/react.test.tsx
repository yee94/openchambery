import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuiPluginsProvider } from './GuiPluginsProvider';
import { useGuiPlugins } from './react';
import { openFileReference } from '@/components/chat/fileReferenceActions';

const state = vi.hoisted(() => ({
  transport: 'host-a', directory: '/project', sessionID: 'session-a' as string | null,
  sessions: {} as Record<string, { id: string; directory: string }>,
  files: {},
  focusFile: undefined as undefined | ((path: string, directory: string) => Promise<void>),
  list: vi.fn(), gui: vi.fn(), hostImports: vi.fn(), signals: [] as AbortSignal[], hostFailure: false,
  hosts: [] as Array<{ install: ReturnType<typeof vi.fn>; uninstall: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; setSession: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => state.transport, getRuntimeKey: () => state.transport, getRuntimeGeneration: () => 0 }));
vi.mock('@/lib/instanceScopedStorage', () => ({ instanceScopedStorageKey: (key: string, runtime: string) => `${runtime}:${key}` }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: state.files }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (value: object) => unknown) => select({ currentSessionId: state.sessionID }) }));
vi.mock('@/sync/sync-context', () => ({ useCurrentSessionEntity: (id: string | null) => id ? state.sessions[id] ?? null : null }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (value: object) => unknown) => select({ currentDirectory: state.directory }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: object) => unknown) => select({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('@/components/chat/fileReferenceActions', () => ({ openFileReference: vi.fn(async () => {}) }));
vi.mock('@/lib/opencode/gui', () => ({ createGuiClient: (signal: AbortSignal) => { state.signals.push(signal); return { plugin: { list: state.list, gui: state.gui } }; } }));
vi.mock('@/components/gui-plugins/GuiPluginSurface', () => ({ GuiPluginSurface: () => null }));
vi.mock('./host', () => { state.hostImports(); return {
  GuiPluginHost: class {
    snapshot = { plugins: [], commands: [], panels: [], settings: [], menuItems: [], activePanel: null };
    install = vi.fn(); uninstall = vi.fn(); dispose = vi.fn(); setSession = vi.fn(); setAppearance = vi.fn();
    subscribe = () => () => {};
    getSnapshot = () => this.snapshot;
    constructor(options: { focusFile: (path: string, directory: string) => Promise<void> }) {
      if (state.hostFailure) throw new Error('host unavailable');
      state.focusFile = options.focusFile; state.hosts.push(this);
    }
  },
}; });

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let context: ReturnType<typeof useGuiPlugins>;
let idleTasks: Map<number, IdleRequestCallback>;
const plugin = { id: 'dsl', features: { gui: true }, source: { type: 'package', target: 'example-dsl' }, state: { status: 'active' } };
const bundle = { code: 'exports.default={setup(){}}', revision: 'one', options: {} };
const Probe = () => { context = useGuiPlugins(); return null; };
const Demand = () => {
  const { requested, requestLoad } = useGuiPlugins();
  React.useEffect(() => { if (!requested) requestLoad(); }, [requested, requestLoad]);
  return null;
};
const draw = (requesters = 0) => root.render(<QueryClientProvider client={client}><GuiPluginsProvider><Probe />
  {Array.from({ length: requesters }, (_, index) => <Demand key={index} />)}
</GuiPluginsProvider></QueryClientProvider>);
const settle = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
};
const load = async () => {
  await act(async () => draw()); await settle();
  await act(async () => context.requestLoad()); await settle(); await settle();
};

beforeEach(() => {
  idleTasks = new Map();
  let idleID = 0;
  vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => { idleTasks.set(++idleID, callback); return idleID; }));
  vi.stubGlobal('cancelIdleCallback', vi.fn((id: number) => idleTasks.delete(id)));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.transport = 'host-a'; state.hosts.length = 0; state.signals.length = 0; state.hostFailure = false;
  state.directory = '/project'; state.sessionID = 'session-a';
  state.sessions = { 'session-a': { id: 'session-a', directory: '/project' } };
  state.list.mockReset().mockResolvedValue({ data: [plugin] });
  state.gui.mockReset().mockResolvedValue({ data: bundle });
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); container.remove();
  vi.unstubAllGlobals();
});

it('keeps initial render light across 50 rerenders before idle preload starts', async () => {
  await act(async () => draw()); await settle();
  for (let index = 0; index < 50; index++) await act(async () => draw());
  expect(context.requested).toBe(false);
  expect(context.loading).toBe(false);
  expect(context.inventory).toEqual([{ id: 'dsl', enabled: true }]);
  expect(state.list).toHaveBeenCalledOnce();
  await act(async () => context.refresh()); await settle();
  expect(state.list).toHaveBeenCalledTimes(2);
  expect(state.gui).not.toHaveBeenCalled();
  expect(state.hostImports).not.toHaveBeenCalled();
  expect(state.hosts).toHaveLength(0);
});

it('preloads and installs at idle, so the first file demand reuses the ready host', async () => {
  await act(async () => draw()); await settle();
  expect(idleTasks.size).toBe(1);
  await act(async () => {
    for (const callback of [...idleTasks.values()]) callback({ didTimeout: false, timeRemaining: () => 10 });
  });
  await settle(); await settle();
  expect(context.requested).toBe(true);
  expect(state.gui).toHaveBeenCalledOnce();
  expect(state.hosts[0].install).toHaveBeenCalledWith('dsl', bundle);
  await act(async () => draw(2)); await settle();
  expect(state.gui).toHaveBeenCalledOnce();
  expect(state.hosts).toHaveLength(1);
});

it('cancels idle preload when disabled or switched, and ignores a stale idle callback', async () => {
  await act(async () => draw()); await settle();
  const stale = [...idleTasks.values()][0];
  await act(async () => context.setEnabled('dsl', false));
  expect(idleTasks.size).toBe(0);
  state.transport = 'host-b';
  await act(async () => draw()); await settle();
  await act(async () => stale({ didTimeout: true, timeRemaining: () => 0 }));
  expect(context.requested).toBe(false);
  expect(state.gui).not.toHaveBeenCalled();
});

it.each(['server-only', 'failed', 'disabled'] as const)('does not schedule background work for %s plugins', async (kind) => {
  if (kind === 'server-only') state.list.mockResolvedValue({ data: [{ ...plugin, features: { server: true } }] });
  if (kind === 'failed') state.list.mockResolvedValue({ data: [{ ...plugin, state: { status: 'failed', error: 'setup failed' } }] });
  if (kind === 'disabled') localStorage.setItem('host-a:gui-plugins.disabled', '["dsl"]');
  await act(async () => draw()); await settle();
  expect(idleTasks.size).toBe(0);
  expect(state.hosts).toHaveLength(0);
  expect(state.gui).not.toHaveBeenCalled();
});

it('coalesces concurrent consumers and keeps warm activation when all consumers close and reopen', async () => {
  await act(async () => draw(2)); await settle(); await settle();
  expect(context.requested).toBe(true);
  expect(state.hosts).toHaveLength(1);
  expect(state.gui).toHaveBeenCalledOnce();
  const host = state.hosts[0];
  await act(async () => draw()); await settle();
  expect(host.dispose).not.toHaveBeenCalled();
  expect(host.uninstall).not.toHaveBeenCalled();
  await act(async () => draw(2)); await settle();
  expect(state.hosts).toHaveLength(1);
  expect(state.gui).toHaveBeenCalledOnce();
  expect(host.install).toHaveBeenCalledOnce();
});

it.each(['disabled', 'no GUI'] as const)('does not import a host or download bundles for %s inventory', async (scenario) => {
  if (scenario === 'disabled') {
    await act(async () => draw()); await settle();
    await act(async () => context.setEnabled('dsl', false));
  } else state.list.mockResolvedValue({ data: [{ ...plugin, features: { gui: false } }] });
  await load();
  expect(context.requested).toBe(true);
  expect(context.loading).toBe(false);
  expect(state.hosts).toHaveLength(0);
  expect(state.gui).not.toHaveBeenCalled();
});

it('waits for inventory and slow bundles, then finishes loading only after installation', async () => {
  let inventory!: (value: { data: typeof plugin[] }) => void;
  let complete!: (value: { data: typeof bundle }) => void;
  state.list.mockImplementationOnce(() => new Promise((resolve) => { inventory = resolve; }));
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await act(async () => draw()); await settle();
  expect(context.loading).toBe(true);
  await act(async () => context.requestLoad());
  expect(state.hosts).toHaveLength(0);
  await act(async () => inventory({ data: [plugin] })); await settle(); await settle();
  expect(context.host).not.toBeNull();
  expect(context.loading).toBe(true);
  expect(state.hosts[0].install).not.toHaveBeenCalled();
  await act(async () => complete({ data: bundle })); await settle();
  expect(state.hosts[0].install).toHaveBeenCalledWith('dsl', bundle);
  expect(context.loading).toBe(false);
});

it('finishes failed loading, exposes per-plugin errors, and retries without remounting successful plugins', async () => {
  state.list.mockResolvedValue({ data: [plugin, { ...plugin, id: 'broken' }] });
  state.gui.mockImplementation(({ id }: { id: string }) => id === 'broken' ? Promise.reject(new Error('bundle unavailable')) : Promise.resolve({ data: bundle }));
  await load();
  await vi.waitFor(async () => {
    await settle();
    expect(context.inventory.find((item) => item.id === 'broken')?.error).toBe('bundle unavailable');
    expect(context.loading).toBe(false);
  });
  const host = state.hosts[0];
  expect(context.loading).toBe(false);
  expect(context.inventory.find((item) => item.id === 'broken')?.error).toBe('bundle unavailable');
  expect(host.install).toHaveBeenCalledWith('dsl', bundle);
  expect(host.uninstall).not.toHaveBeenCalled();
  state.gui.mockResolvedValue({ data: bundle });
  await act(async () => context.refresh()); await settle(); await settle();
  expect(context.loading).toBe(false);
  expect(context.inventory.every((item) => !item.error)).toBe(true);
  expect(host.install).toHaveBeenCalledWith('broken', bundle);
  expect(host.dispose).not.toHaveBeenCalled();
  expect(host.uninstall).not.toHaveBeenCalled();
  expect(state.hosts).toHaveLength(1);
});

it('finishes failed inventory and preference reads, and refresh recovers without implicitly requesting', async () => {
  state.list.mockRejectedValue(new Error('inventory unavailable'));
  localStorage.setItem('host-a:gui-plugins.disabled', '{}');
  await act(async () => draw()); await settle(); await settle();
  expect(context.loading).toBe(false);
  expect(context.error).toBe('Invalid GUI plugin enable-state');
  localStorage.removeItem('host-a:gui-plugins.disabled');
  await act(async () => context.refresh()); await settle(); await settle();
  expect(context.error).toBe('inventory unavailable');
  expect(context.loading).toBe(false);
  state.list.mockResolvedValue({ data: [plugin] });
  await act(async () => context.refresh()); await settle();
  expect(context.error).toBeNull();
  expect(context.requested).toBe(false);
  expect(state.gui).not.toHaveBeenCalled();
});

it('mounted consumers request the new transport again and old host clients are aborted', async () => {
  await act(async () => draw(2)); await settle(); await settle();
  const old = state.hosts[0];
  const signals = [...state.signals];
  state.transport = 'host-b';
  await act(async () => draw(2)); await settle(); await settle();
  expect(old.dispose).toHaveBeenCalledOnce();
  expect(signals.some((signal) => signal.aborted)).toBe(true);
  expect(context.requested).toBe(true);
  expect(state.hosts).toHaveLength(2);
  expect(state.gui).toHaveBeenCalledTimes(2);
});

it('ends loading after host failure and refresh retries the host only after demand', async () => {
  state.hostFailure = true;
  await load();
  expect(context.loading).toBe(false);
  expect(context.error).toBe('host unavailable');
  expect(state.gui).not.toHaveBeenCalled();
  state.hostFailure = false;
  await act(async () => context.refresh()); await settle(); await settle();
  expect(context.error).toBeNull();
  expect(context.loading).toBe(false);
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0].install).toHaveBeenCalledWith('dsl', bundle);
});

it('isolates late inventory and resets demand even when returning to an earlier transport', async () => {
  let complete!: (value: { data: typeof plugin[] }) => void;
  state.list.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await act(async () => draw()); await settle();
  await act(async () => context.requestLoad());
  state.transport = 'host-b';
  await act(async () => draw()); await settle();
  expect(context.requested).toBe(false);
  await act(async () => complete({ data: [plugin] })); await settle();
  expect(state.hosts).toHaveLength(0);
  state.transport = 'host-a';
  await act(async () => draw()); await settle();
  expect(context.requested).toBe(false);
  expect(state.hosts).toHaveLength(0);
  expect(state.gui).not.toHaveBeenCalled();
});

it('loads once, synchronizes only the current session, and disabling removes GUI without removing its server plugin', async () => {
  await load();
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0].install).toHaveBeenCalledWith('dsl', bundle);
  expect(state.hosts[0].setSession).toHaveBeenLastCalledWith({ id: 'session-a', directory: '/project' });
  const sessionUpdates = state.hosts[0].setSession.mock.calls.length;
  for (let index = 0; index < 50; index++) await act(async () => draw());
  expect(state.list).toHaveBeenCalledOnce();
  expect(state.gui).toHaveBeenCalledOnce();
  expect(state.hosts[0].setSession).toHaveBeenCalledTimes(sessionUpdates);
  await act(async () => context.setEnabled('dsl', false));
  expect(state.hosts[0].uninstall).toHaveBeenCalledWith('dsl');
  expect(state.hosts[0].dispose).not.toHaveBeenCalled();
  expect(context.inventory[0].enabled).toBe(false);
  await act(async () => context.setEnabled('dsl', true)); await settle();
  expect(state.hosts).toHaveLength(1);
  expect(state.hosts[0].install).toHaveBeenCalledTimes(2);
});

it('routes host navigation through existing file actions using the supplied session directory and cancels disposed runtime callbacks', async () => {
  await load();
  const focus = state.focusFile!;
  vi.mocked(openFileReference).mockClear();
  await focus('/worktrees/other/demo.eficy', '/session-owner');
  expect(openFileReference).toHaveBeenLastCalledWith('/worktrees/other/demo.eficy', false, { effectiveDirectory: '/session-owner' });
  state.transport = 'host-b';
  await act(async () => draw()); await settle();
  await focus('/old/stale.eficy', '/old');
  expect(openFileReference).toHaveBeenCalledTimes(1);
});

it('successful empty inventory tears down plugins and a server-failed plugin cannot retain its GUI', async () => {
  await load();
  await act(async () => client.setQueryData(['host-a', 'plugins', 'gui', null, 'inventory'], [
    { ...plugin, state: { status: 'failed', error: 'server setup failed' } },
  ])); await settle();
  expect(state.hosts[0].uninstall).toHaveBeenCalledWith('dsl');
  expect(context.inventory[0].error).toBe('server setup failed');
  await act(async () => client.setQueryData(['host-a', 'plugins', 'gui', null, 'inventory'], [])); await settle();
  expect(state.hosts[0].dispose).toHaveBeenCalledOnce();
  expect(context.host).toBeNull();
});

it('keeps the session workspace when unrelated global directory selection changes', async () => {
  await load();
  const host = state.hosts[0];
  const updates = host.setSession.mock.calls.length;
  for (let index = 0; index < 50; index++) {
    state.directory = `/other-project-${index}`;
    await act(async () => draw());
  }
  expect(host.setSession).toHaveBeenCalledTimes(updates);
  expect(host.setSession).toHaveBeenLastCalledWith({ id: 'session-a', directory: '/project' });
  state.sessions['session-a'] = { id: 'session-a', directory: '/moved-worktree' };
  await act(async () => draw());
  expect(host.setSession).toHaveBeenLastCalledWith({ id: 'session-a', directory: '/moved-worktree' });
});

it('waits for cold session metadata and clears the old scope while the next session is unresolved', async () => {
  state.sessions = {};
  state.directory = '/unrelated';
  await load();
  const host = state.hosts[0];
  expect(host.setSession).toHaveBeenLastCalledWith(undefined);
  state.sessions['session-a'] = { id: 'session-a', directory: '/project' };
  await act(async () => draw());
  expect(host.setSession).toHaveBeenLastCalledWith({ id: 'session-a', directory: '/project' });
  state.sessionID = 'session-b';
  await act(async () => draw());
  expect(host.setSession).toHaveBeenLastCalledWith(undefined);
  const updates = host.setSession.mock.calls.length;
  state.sessions['session-a'] = { id: 'session-a', directory: '/late-old-directory' };
  await act(async () => draw());
  expect(host.setSession).toHaveBeenCalledTimes(updates);
  state.sessions['session-b'] = { id: 'session-b', directory: '/second-project' };
  await act(async () => draw());
  expect(host.setSession).toHaveBeenLastCalledWith({ id: 'session-b', directory: '/second-project' });
  state.sessionID = null;
  await act(async () => draw());
  expect(host.setSession).toHaveBeenLastCalledWith(undefined);
});

it('switching runtime disposes the old host and never applies a late bundle to it', async () => {
  let complete!: (value: { data: typeof bundle }) => void;
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await load();
  const old = state.hosts[0];
  expect(old.install).not.toHaveBeenCalled();
  state.transport = 'host-b';
  await act(async () => draw()); await settle(); await settle();
  expect(context.requested).toBe(false);
  expect(context.host).toBeNull();
  expect(state.hosts).toHaveLength(1);
  await act(async () => complete({ data: bundle })); await settle();
  expect(old.dispose).toHaveBeenCalledOnce();
  expect(old.install).not.toHaveBeenCalled();
  await act(async () => context.requestLoad()); await settle(); await settle();
  expect(state.hosts.at(-1)?.install).toHaveBeenCalledWith('dsl', bundle);
});
