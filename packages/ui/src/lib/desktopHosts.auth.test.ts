import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({ fetch: mocks.fetch, close: mocks.close }),
}));
import { probeRelayDesktopHost } from './desktopHosts';

const relay = { relayUrl: 'wss://relay.example', serverId: 'remote', hostEncPubJwk: {} };

describe('relay desktop authentication probe', () => {
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it('keeps the authenticated tunnel for the first runtime request', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ authenticated: true }));
    const result = await probeRelayDesktopHost(relay, { keepTunnel: true, clientToken: 'test-client' });
    expect(result.status).toBe('ok');
    expect(result.tunnel).toBeDefined();
    expect(mocks.fetch).toHaveBeenCalledWith('/auth/session', { headers: { Authorization: 'Bearer test-client' } });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it.each([401, 403])('closes rejected tunnels on HTTP %s', async (status) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status }));
    const result = await probeRelayDesktopHost(relay, { keepTunnel: true, clientToken: 'revoked-test-client' });
    expect(result.status).toBe('auth');
    expect(result.tunnel).toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('requires the session payload to confirm authentication', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ authenticated: false }));
    expect((await probeRelayDesktopHost(relay)).status).toBe('auth');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('bounds an unresponsive handshake and closes its tunnel', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = probeRelayDesktopHost(relay, { keepTunnel: true });
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe('unreachable');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
