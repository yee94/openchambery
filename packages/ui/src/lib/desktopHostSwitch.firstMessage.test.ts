import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tunnelFetch: vi.fn(), close: vi.fn(), createTunnel: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => true, hasDesktopInvoke: () => true, invokeDesktop: mocks.invoke }));
vi.mock('@/lib/desktopRelayRestore', () => ({ scheduleDesktopHostCandidateRefresh: vi.fn() }));
vi.mock('@/lib/relay/tunnel-client', () => ({ createRelayTunnelClient: mocks.createTunnel }));

import { switchDesktopHost } from './desktopHostSwitch';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeKey, switchRuntimeEndpoint } from './runtime-switch';
import { deactivateRelayTunnel } from './relay/runtime-tunnel';

describe('first message after switching desktop instance', () => {
  afterEach(() => { deactivateRelayTunnel(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('commits the verified tunnel and sends the first message with the remote credential', async () => {
    const networkFetch = vi.fn(async (_input: unknown) => Response.json({ token: 'test-url-token', expiresAt: Date.now() + 60000 }));
    vi.stubGlobal('fetch', networkFetch);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local', clientToken: 'test-local-client' });
    await Promise.resolve();
    mocks.invoke.mockResolvedValue({ status: 'auth', latencyMs: 1 });
    mocks.tunnelFetch.mockImplementation(async (input: string | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get('Authorization') !== 'Bearer test-remote-client') return new Response(null, { status: 401 });
      const path = typeof input === 'string' ? input : new URL(input.url).pathname;
      if (path === '/auth/session') return Response.json({ authenticated: true });
      if (path === '/auth/url-token') return Response.json({ token: 'test-remote-url-token', expiresAt: Date.now() + 60000 });
      return Response.json({ accepted: true });
    });
    const tunnel = { fetch: mocks.tunnelFetch, close: mocks.close };
    mocks.createTunnel.mockReturnValue(tunnel);
    const result = await switchDesktopHost({
      id: 'first-remote', label: 'Remote', url: 'https://remote.example', clientToken: 'test-remote-client',
      relay: { relayUrl: 'wss://relay.example', serverId: 'remote', hostEncPubJwk: {} },
    }, { cachedProbe: { status: 'ok', latencyMs: 1 } });

    expect(result.ok && result.via).toBe('relay');
    expect(getRuntimeKey()).toBe('host:first-remote');
    const response = await runtimeFetch('/api/session/test-session/prompt_async', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocks.createTunnel).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(networkFetch.mock.calls.some((call) => String(call[0]).includes('prompt_async'))).toBe(false);
  });
});
