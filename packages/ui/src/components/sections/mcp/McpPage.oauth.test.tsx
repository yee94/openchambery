import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  generation: 0,
  servers: [] as Array<Record<string, unknown>>,
  list: vi.fn(), integration: vi.fn(), connect: vi.fn(), status: vi.fn(), update: vi.fn(),
  open: vi.fn(), success: vi.fn(), error: vi.fn(), refresh: vi.fn(),
}));
vi.mock('@/lib/opencode/client', () => {
  const api = { mcp: { list: state.list }, integration: { get: state.integration, oauth: { connect: state.connect, status: state.status } } };
  return { opencodeClient: { getApiClient: () => api, getScopedApiClient: () => api } };
});
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => 'runtime-a' }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: {} }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ currentDirectory: '/workspace' }) } }));
vi.mock('@/queries/mcpQueries', () => ({
  normalizeMcpDirectory: (value: string | null) => value,
  resolveMcpConfigQueryDirectory: () => '/workspace',
  useMcpConfigsQuery: () => ({ data: state.servers }),
  useMcpStatusQuery: () => ({ data: { remote: { status: 'needs_auth' } } }),
  readMcpStatusSnapshot: () => ({ remote: { status: 'needs_auth' } }),
  refreshMcpStatusQuery: state.refresh,
}));
vi.mock('@/stores/useMcpConfigStore', () => ({
  useMcpConfigStore: (select: (value: unknown) => unknown) => select({ selectedMcpName: 'remote', mcpDraft: null, updateMcp: state.update }),
  envRecordToArray: () => [],
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }) }));
function translate(key: string) { return key; }
vi.mock('@/lib/url', () => ({ openExternalUrl: state.open }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));
vi.mock('@/components/ui', () => ({ toast: { success: state.success, error: state.error, message: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Box }));
vi.mock('@/components/sections/shared/SettingsActionHeader', () => ({ SettingsActionHeader: Box }));
vi.mock('@/components/sections/shared/SettingsGroup', () => ({ SettingsGroup: Box, SettingsRow: Box }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: Box, DialogDescription: Box, DialogFooter: Box, DialogHeader: Box, DialogTitle: Box }));
vi.mock('@/components/ui/collapsible', () => ({ Collapsible: Box, CollapsibleContent: Box, CollapsibleTrigger: Box }));
vi.mock('@/components/ui/select', () => ({ Select: Box, SelectContent: () => null, SelectItem: Box, SelectTrigger: Box }));
function Box({ children }: React.PropsWithChildren) { return <div>{children}</div>; }
import { McpPage } from './McpPage';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.generation++;
  state.servers = [{ name: 'remote', type: 'remote', url: 'https://mcp.example.com', enabled: true }];
  state.list.mockResolvedValue({ data: [{ name: 'remote', integrationID: 'mcp-owned' }] });
  state.integration.mockResolvedValue({ data: { id: 'mcp-owned', methods: [{ type: 'oauth', id: 'login' }], connections: [] } });
  state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', url: 'https://auth.example.com/authorize', mode: 'auto', time: { created: Date.now(), expires: Date.now() + 600_000 } } });
  state.status.mockResolvedValue({ data: { status: 'complete' } });
  state.open.mockResolvedValue(true);
  state.update.mockResolvedValue({ ok: true });
  state.refresh.mockResolvedValue({ remote: { status: 'connected' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function authorize() {
  await act(async () => root.render(<McpPage />));
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent === 'settings.mcp.page.actions.authorize');
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

test('Authorize reaches V2 integration OAuth and opens the returned URL without rewriting the callback', async () => {
  await authorize();
  expect(state.error).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(state.open).toHaveBeenCalledExactlyOnceWith('https://auth.example.com/authorize');
  expect(state.connect).toHaveBeenCalledWith({ integrationID: 'mcp-owned', methodID: 'login', location: { directory: '/workspace' } });
  expect(host.textContent).not.toContain('settings.mcp.page.auth.manualFallbackTitle');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(state.success).toHaveBeenCalledWith('settings.mcp.page.toast.authorizationCompleted');
});

test('removes the legacy Yuri callback before starting the OpenCode-owned flow', async () => {
  state.servers[0].oauth = { redirectUri: 'https://app.example.com/mcp/oauth/callback?server=remote' };
  await authorize();
  expect(state.update).toHaveBeenCalledWith('remote', expect.objectContaining({ oauthRedirectUri: '' }));
  expect(state.open).toHaveBeenCalledWith('https://auth.example.com/authorize');
});

test('reports an OAuth failure even while the MCP status still says needs_auth', async () => {
  state.status.mockResolvedValue({ data: { status: 'failed', message: 'Authorization denied' } });
  await authorize();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(state.error).toHaveBeenCalledWith('Authorization denied');
  expect(state.success).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(state.status).toHaveBeenCalledTimes(1);
});

test('does not open a late authorization URL after leaving the page', async () => {
  let finish!: (value: unknown) => void;
  state.connect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await authorize();
  await act(async () => root.render(null));
  await act(async () => finish({ data: { attemptID: 'late', url: 'https://auth.example.com/authorize', mode: 'auto', time: { expires: Date.now() + 60_000 } } }));
  expect(state.open).not.toHaveBeenCalled();
});
