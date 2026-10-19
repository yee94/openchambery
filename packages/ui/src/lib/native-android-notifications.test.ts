import { describe, expect, it, vi } from 'vitest';
vi.mock('@capacitor/core', () => ({ Capacitor: {}, registerPlugin: () => ({}) }));
vi.mock('@/apps/mobileConnections', () => ({ loadMobileConnections: vi.fn(), mobileConnectionKey: vi.fn() }));
vi.mock('@/lib/runtime-auth', () => ({ buildRuntimeAuthHeaders: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getActiveRelayDescriptor: vi.fn(), getRuntimeApiBaseUrl: vi.fn(), getRuntimeKey: vi.fn() }));
import { createAndroidNotificationController, resolveAndroidNotificationConfig, type AndroidNotificationConfig } from './native-android-notifications';
import { loadMobileConnections, mobileConnectionKey } from '@/apps/mobileConnections';
import { buildRuntimeAuthHeaders } from '@/lib/runtime-auth';
import { getActiveRelayDescriptor, getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';

const config = (runtimeKey: string): AndroidNotificationConfig => ({ runtimeKey, baseUrl: 'https://example.test', headers: {}, preferRelay: false, labels: {} });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = (resolveConfig: () => Promise<AndroidNotificationConfig | null>) => {
  const plugin = { stop: vi.fn(async () => {}), configure: vi.fn(async () => ({ state: 'started' as const })) };
  const onError = vi.fn();
  const onState = vi.fn();
  return { plugin, onError, onState, controller: createAndroidNotificationController({ plugin, resolveConfig, onError, onState }) };
};

describe('native Android notification ownership', () => {
  it('stops old credentials before async lookup and fences an older instance after switching', async () => {
    const old = deferred<AndroidNotificationConfig>();
    const resolveConfig = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(config('new'));
    const { controller, plugin } = fixture(resolveConfig);
    const first = controller.refresh();
    await Promise.resolve();
    expect(plugin.stop).toHaveBeenCalledOnce();
    await controller.refresh();
    old.resolve(config('old'));
    await first;
    expect(plugin.configure.mock.calls).toEqual([[{ config: config('new') }]]);
    controller.dispose();
  });
  it('disabling or revoking while a lookup is pending cannot restart the service', async () => {
    const pending = deferred<AndroidNotificationConfig>();
    const { controller, plugin } = fixture(() => pending.promise);
    const running = controller.refresh();
    await Promise.resolve();
    controller.stop();
    pending.resolve(config('old'));
    await running;
    expect(plugin.configure).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('reports permission failure and does no timer-based retries in the WebView', async () => {
    const { controller, plugin, onError } = fixture(async () => config('one'));
    plugin.configure.mockRejectedValueOnce(new Error('denied'));
    await controller.refresh();
    expect(onError).toHaveBeenCalledOnce();
    expect(plugin.configure).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it('captures a paired relay fallback for a direct connection without loading another instance token', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('paired');
    vi.mocked(getRuntimeApiBaseUrl).mockReturnValue('http://example.test');
    vi.mocked(getActiveRelayDescriptor).mockReturnValue(null);
    vi.mocked(buildRuntimeAuthHeaders).mockResolvedValue(new Headers({ Authorization: 'Bearer fixture-token' }));
    const relay = { relayUrl: 'wss://relay.example.test/ws', serverId: 'server', hostEncPubJwk: {} };
    vi.mocked(loadMobileConnections).mockResolvedValue([{ id: 'one', label: 'One', lastUsedAt: 0, candidates: [{ kind: 'relay', relay }] }]);
    vi.mocked(mobileConnectionKey).mockReturnValue('paired');
    const result = await resolveAndroidNotificationConfig({ service: 'Notifications' }, 'zh-CN');
    expect(new Headers(result?.headers).get('accept-language')).toBe('zh-CN');
    expect(result).toMatchObject({ runtimeKey: 'paired', relay, preferRelay: false, baseUrl: 'http://example.test' });
    expect(new Headers(result?.headers).get('authorization')).toBe('Bearer fixture-token');
  });
});
