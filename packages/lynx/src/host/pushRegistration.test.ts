import { describe, expect, test } from 'vitest';

import {
  createLynxNativePushRegistration,
  guardLynxFcmApplicationId,
  LYNX_FCM_APPLICATION_IDS,
} from './pushRegistration';

describe('createLynxNativePushRegistration', () => {
  test('host inject → register posts Cap apns-token', async () => {
    const reg = createLynxNativePushRegistration();
    reg.injectToken({ token: 'tok-1', platform: 'ios', locale: 'zh-CN' });
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    expect(await reg.registerWithServer(runtimeFetch)).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({ path: '/api/push/apns-token', method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      token: 'tok-1',
      platform: 'ios',
      locale: 'zh-CN',
    });
  });

  test('unregister clears stored token', async () => {
    const reg = createLynxNativePushRegistration();
    reg.injectToken({ token: 'tok-2', platform: 'android' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    expect(await reg.unregisterWithServer(runtimeFetch)).toEqual({ status: 'ok' });
    expect(reg.getLastToken()).toBeNull();
  });

  test('FCM package-id guard respects Cap applicationIds', () => {
    const reg = createLynxNativePushRegistration();
    expect(guardLynxFcmApplicationId(reg, LYNX_FCM_APPLICATION_IDS[0])).toBeNull();
    const mismatch = guardLynxFcmApplicationId(reg, 'com.openchamber.app');
    expect(mismatch?.status).toBe('fcm-package-mismatch');
  });

  test('no-token / no-runtime are not fake-success', async () => {
    const reg = createLynxNativePushRegistration();
    expect(await reg.registerWithServer(async () => ({ ok: true, status: 200, json: async () => ({}) }))).toEqual({
      status: 'no-token',
    });
    reg.injectToken({ token: 'x', platform: 'ios' });
    expect(await reg.registerWithServer(null)).toEqual({ status: 'no-runtime' });
  });
});
