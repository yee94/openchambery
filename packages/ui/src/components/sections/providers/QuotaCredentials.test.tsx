import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  directory: '/workspace',
  generation: 0,
  list: vi.fn(),
  integrations: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  fetch: vi.fn(),
  open: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSdkClient: () => ({
      provider: { list: state.list },
      integration: { list: state.integrations, oauth: {
        connect: state.connect, status: state.status, complete: state.complete, cancel: state.cancel,
      } },
    }),
    getDirectory: () => state.directory,
  },
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => state.generation,
  getRuntimeTransportIdentity: () => `runtime-${state.generation}`,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: state.open }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/ui', () => ({ toast: { success: state.success, error: state.error, message: state.message } }));
vi.mock('@/stores/useAgentsStore', () => ({ refreshOpenCodeConfiguration: state.reload }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

import { QuotaCredentials } from './QuotaCredentials';

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;

function integrations(consoleConnection: Array<{ type: string; method?: string; id?: string }>) {
  return {
    data: [
      {
        id: 'opencode',
        name: 'OpenCode Console',
        connections: consoleConnection,
        methods: [{ id: 'device', type: 'oauth', label: 'OpenCode Console account' }, { type: 'key', label: 'API key' }],
      },
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        connections: [],
        methods: [{ id: 'go-key', type: 'key', label: 'Service account' }, { id: 'fake-oauth', type: 'oauth', label: 'Not Console' }],
      },
    ],
  };
}

async function mount(providerId: 'opencode-go' | 'ollama-cloud' = 'opencode-go') {
  await act(async () => {
    root.render(
      <QueryClientProvider client={cache}>
        <QuotaCredentials providerId={providerId} providerName="OpenCode Go" />
      </QueryClientProvider>,
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((el) => el.textContent === label);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.directory = '/workspace';
  state.generation = 0;
  state.list.mockResolvedValue({ data: [{ id: 'opencode-go', integrationID: 'opencode-go' }] });
  state.integrations.mockResolvedValue(integrations([]));
  state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', mode: 'auto', url: 'https://example.com/authorize', instructions: 'Authorize in browser' } });
  state.status.mockResolvedValue({ data: { status: 'pending' } });
  state.cancel.mockResolvedValue(undefined);
  state.complete.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
  state.fetch.mockResolvedValue(new Response(JSON.stringify({ configured: false }), { status: 200 }));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('OpenCode Go Console sign-in', () => {
  it('offers Console sign-in on the Go card and keeps the service-account fields', async () => {
    await mount();
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.consoleSignIn');
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.workspaceId');
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.authCookie');
    expect(host.textContent).not.toContain('Not Console');
  });

  it('starts OAuth on the opencode integration, not the key-only Go integration', async () => {
    await mount();
    await act(async () => {
      button('settings.providers.page.openCodeGo.consoleSignIn')!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state.connect).toHaveBeenCalledWith(
      expect.objectContaining({ integrationID: 'opencode', methodID: 'device', location: { directory: '/workspace' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(state.connect.mock.calls.some(([input]) => input.integrationID === 'opencode-go')).toBe(false);
    expect(state.open).toHaveBeenCalledWith('https://example.com/authorize');
  });

  it('shows Go as credentialed when Console already has an OAuth grant', async () => {
    state.integrations.mockResolvedValue(integrations([{ type: 'credential', id: 'cred_account', method: 'oauth' }]));
    await mount();
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.consoleConnected');
    expect(button('settings.providers.page.openCodeGo.consoleSignIn')).toBeUndefined();
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.workspaceId');
  });

  it('does not treat a Console API key as a Console account', async () => {
    state.integrations.mockResolvedValue(integrations([{ type: 'credential', id: 'cred_key', method: 'key' }]));
    await mount();
    expect(button('settings.providers.page.openCodeGo.consoleSignIn')).toBeTruthy();
    expect(host.textContent).not.toContain('settings.providers.page.openCodeGo.consoleConnected');
  });

  it('still saves workspace id and auth cookie', async () => {
    await mount();
    const [workspace, cookie] = [...host.querySelectorAll('input')];
    await act(async () => {
      for (const [input, value] of [[workspace, 'wrk_123'], [cookie, 'auth-cookie']] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ configured: true, workspaceId: 'wrk_123' }), { status: 200 }));
    await act(async () => {
      button('settings.providers.page.openCodeGo.save')!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    const save = state.fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(save?.[0]).toBe('/api/quota/credentials/opencode-go');
    expect(JSON.parse(save?.[1].body)).toEqual({ workspaceId: 'wrk_123', authCookie: 'auth-cookie' });
  });

  it('shows Go as credentialed after Console OAuth completes', async () => {
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    state.integrations
      .mockResolvedValueOnce(integrations([]))
      .mockResolvedValue(integrations([{ type: 'credential', id: 'cred_account', method: 'oauth' }]));
    await mount();
    await act(async () => {
      button('settings.providers.page.openCodeGo.consoleSignIn')!.click();
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(state.connect.mock.calls[0][0].integrationID).toBe('opencode');
    expect(host.textContent).toContain('settings.providers.page.openCodeGo.consoleConnected');
    expect(state.success).toHaveBeenCalledWith('settings.providers.page.toast.oauthCompleted');
  });

  it('does not offer Console sign-in on other quota cards', async () => {
    await mount('ollama-cloud');
    expect(host.textContent).not.toContain('settings.providers.page.openCodeGo.consoleSignIn');
  });
});
