import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  probe: vi.fn(),
  relayProbe: vi.fn(),
  switchEndpoint: vi.fn(),
  adopt: vi.fn(),
}));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => true }));
vi.mock('@/lib/desktopHosts', () => ({
  desktopPrepareHost: mocks.prepare,
  desktopHostProbe: mocks.probe,
  probeRelayDesktopHost: mocks.relayProbe,
  getDesktopHostApiUrl: (host: { url: string }) => host.url,
  normalizeHostUrl: (url: string) => url.startsWith('http') ? url : null,
}));
vi.mock('@/lib/desktopRelayRestore', () => ({
  desktopRelayApiBaseUrl: () => 'http://127.0.0.1:57123',
  scheduleDesktopHostCandidateRefresh: vi.fn(),
}));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ adoptRelayTunnel: mocks.adopt }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'local', switchRuntimeEndpoint: mocks.switchEndpoint }));

import { switchDesktopHost } from './desktopHostSwitch';

const host = { id: 'remote', label: 'Remote', url: 'https://remote.example', clientToken: 'test-client' };
const relay = { relayUrl: 'wss://relay.example', serverId: 'remote', hostEncPubJwk: {} };

describe('desktop switch authentication readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockImplementation(async (value) => value);
    mocks.probe.mockResolvedValue({ status: 'auth', latencyMs: 10 });
    mocks.relayProbe.mockResolvedValue({ status: 'ok', latencyMs: 20 });
  });

  it('keeps the current instance when direct credentials are rejected', async () => {
    const result = await switchDesktopHost(host);
    expect(result.ok).toBe(false);
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
  });

  it('waits for SSH preparation even with a ready badge, then uses refreshed credentials and URL', async () => {
    let finish!: (value: typeof host) => void;
    mocks.prepare.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.probe.mockResolvedValue({ status: 'ok', latencyMs: 1 });
    const pending = switchDesktopHost(host, { cachedProbe: { status: 'ok', latencyMs: 1 } });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
    finish({ ...host, url: 'http://127.0.0.1:54321', clientToken: 'refreshed-client' });
    expect((await pending).ok).toBe(true);
    expect(mocks.switchEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      apiBaseUrl: 'http://127.0.0.1:54321', clientToken: 'refreshed-client',
    }));
  });

  it('does not bypass failed SSH preparation through relay', async () => {
    mocks.prepare.mockRejectedValue(new Error('Remote update failed'));
    await expect(switchDesktopHost({ ...host, relay })).rejects.toThrow('Remote update failed');
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.relayProbe).not.toHaveBeenCalled();
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
  });

  it('revalidates an old connected badge before committing a switch', async () => {
    const result = await switchDesktopHost(host, { cachedProbe: { status: 'ok', latencyMs: 1 } });
    expect(result.ok).toBe(false);
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
  });

  it('uses authenticated relay fallback on the first switch when direct auth fails', async () => {
    const result = await switchDesktopHost({ ...host, relay });
    expect(result.ok && result.via).toBe('relay');
    expect(mocks.relayProbe).toHaveBeenCalledWith(relay, { keepTunnel: true, clientToken: host.clientToken });
    expect(mocks.probe).toHaveBeenCalledWith(host.url, expect.objectContaining({ expectedServerId: relay.serverId }));
  });

  it('keeps switching pending until the target authentication probe completes', async () => {
    let finish!: (value: { status: string; latencyMs: number }) => void;
    mocks.probe.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = switchDesktopHost(host, { cachedProbe: { status: 'ok', latencyMs: 1 } });
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
    await Promise.resolve();
    finish({ status: 'ok', latencyMs: 10 });
    expect((await pending).ok).toBe(true);
    expect(mocks.switchEndpoint).toHaveBeenCalledOnce();
  });

  it('preserves the active instance when both transports reject credentials', async () => {
    mocks.relayProbe.mockResolvedValue({ status: 'auth', latencyMs: 20 });
    const result = await switchDesktopHost({ ...host, relay });
    expect(result.ok).toBe(false);
    expect(result.status.status).toBe('auth');
    expect(mocks.adopt).not.toHaveBeenCalled();
    expect(mocks.switchEndpoint).not.toHaveBeenCalled();
  });
});
