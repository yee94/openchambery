import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ appId: vi.fn(), identity: 'host-a', fetch: vi.fn() }));
vi.mock('@yuriai/ui/lib/mobileAppVersion', () => ({ getMobileAppId: mocks.appId }));
vi.mock('@yuriai/ui/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => mocks.identity }));
vi.mock('@yuriai/ui/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
import { createWebPushAPI } from './push';

afterEach(() => { vi.resetAllMocks(); mocks.identity = 'host-a'; });

it('adds installed identity to both native token registration endpoints', async () => {
  mocks.appId.mockResolvedValue('com.example.installed');
  mocks.fetch.mockResolvedValue(new Response('{"ok":true}'));
  const api = createWebPushAPI();
  await api.registerApnsToken({ token: 'alert', platform: 'ios' });
  mocks.fetch.mockResolvedValue(new Response('{"ok":true}'));
  await api.registerLiveActivityToken({ token: 'live', activityId: 'a', sessionId: 's' });
  expect(mocks.fetch.mock.calls.map(([path, options]) => [path, JSON.parse(options.body).bundleId])).toEqual([
    ['/api/push/apns-token', 'com.example.installed'], ['/api/push/live-activity-token', 'com.example.installed'],
  ]);
});

it('does not guess an app or register against another runtime when identity discovery fails or races a switch', async () => {
  const api = createWebPushAPI();
  mocks.appId.mockRejectedValue(new Error('unavailable'));
  expect(await api.registerApnsToken({ token: 'alert' })).toBeNull();
  mocks.appId.mockImplementation(async () => { mocks.identity = 'host-b'; return 'com.example.installed'; });
  expect(await api.registerLiveActivityToken({ token: 'live', activityId: 'a', sessionId: 's' })).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
