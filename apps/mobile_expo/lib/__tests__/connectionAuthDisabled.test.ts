import { describe, expect, it, afterEach } from 'vitest';

import {
  isAuthDisabledSession,
  parsePairingRedeemToken,
  parsePairingRedeemServerLabel,
  probeSavedCandidates,
  redeemPairing,
  setConnectionHttp,
  setOpenRelaySession,
} from '@/lib/connectionApi';
import { ConnectionController } from '@/lib/connectionController';
import { MemoryMetaStore, setMetaStoreBackend } from '@/lib/metaStore';
import { MemorySecureStore, setSecureStoreBackend } from '@/lib/secureStore';
import { resetDeviceIdCacheForTests } from '@/lib/deviceId';
import { encodePairingConnectionPayload } from '@/lib/connectionPayload';

afterEach(() => {
  setConnectionHttp(null);
  setOpenRelaySession(null);
  setMetaStoreBackend(null);
  setSecureStoreBackend(null);
  resetDeviceIdCacheForTests();
});

describe('parsePairingRedeemToken', () => {
  it('reads top-level clientToken (server PairingRedeemResponse)', () => {
    expect(parsePairingRedeemToken({ ok: true, clientToken: '  tok-a  ' })).toBe('tok-a');
  });

  it('falls back to token / nested client.token', () => {
    expect(parsePairingRedeemToken({ token: 'tok-b' })).toBe('tok-b');
    expect(parsePairingRedeemToken({ client: { token: 'tok-c' } })).toBe('tok-c');
  });

  it('returns empty for missing or non-string tokens', () => {
    expect(parsePairingRedeemToken(null)).toBe('');
    expect(parsePairingRedeemToken({ ok: true, clientToken: 12 })).toBe('');
    expect(parsePairingRedeemServerLabel({ server: { label: ' Studio ' } })).toBe('Studio');
  });
});

describe('probe auth-disabled', () => {
  it('URL connect without token succeeds when session.disabled=true', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    setSecureStoreBackend(new MemorySecureStore());
    setConnectionHttp({
      request: async (url) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/auth/session')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ authenticated: true, disabled: true }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });

    const probe = await probeSavedCandidates(
      [{ kind: 'direct', url: 'http://192.168.1.74:2606' }],
      undefined,
    );
    expect(probe.status).toBe('ok');
    expect(probe.value?.kind).toBe('direct');

    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    expect(await controller.connectWithUrl({ url: 'http://192.168.1.74:2606' })).toBe(true);
    expect(controller.getState().phase).toBe('connected');
    expect(controller.getState().active?.clientToken).toBeNull();
    expect(controller.getState().error).toBeNull();
  });

  it('isAuthDisabledSession matches Cap disabled:true', () => {
    expect(isAuthDisabledSession({ authenticated: true, disabled: true })).toBe(true);
    expect(isAuthDisabledSession({ authenticated: false, disabled: false })).toBe(false);
    expect(isAuthDisabledSession(null)).toBe(false);
  });
});

describe('redeem pairing auth-disabled fallback', () => {
  it('adopts tokenless when redeem HTTP fails but session is auth-disabled', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    setSecureStoreBackend(new MemorySecureStore());
    let redeemBody: string | null = null;
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          redeemBody = typeof init.body === 'string' ? init.body : null;
          return { ok: false, status: 400, json: async () => ({ error: 'Invalid or expired pairing session' }) };
        }
        if (url.endsWith('/auth/session')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ authenticated: true, disabled: true }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });

    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    const encoded = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_expired',
      secret: 'used-once',
      label: 'LAN Box',
      candidates: [{ type: 'lan', url: 'http://192.168.1.74:2606' }],
    });
    expect(await controller.redeemPairingLink(encoded)).toBe(true);
    expect(controller.getState().phase).toBe('connected');
    expect(controller.getState().active?.clientToken).toBeNull();
    expect(controller.getState().error).toBeNull();
    expect(redeemBody).toBeTruthy();
    const parsed = JSON.parse(redeemBody!);
    expect(parsed.clientKind).toBe('mobile');
    expect(parsed.deviceName).toBe('OpenChamber Expo');
    expect(parsed).toHaveProperty('dedupeKey');
    expect(String(parsed.dedupeKey)).toMatch(/^mobile:/);
    // devicePlatform is included when Platform.OS is ios/android; JSON.stringify
    // omits the key when undefined (node unit tests) — same as Cap.
  });

  it('surfaces pairingFailed (not authRequired) when redeem fails and auth is enabled', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    setSecureStoreBackend(new MemorySecureStore());
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return { ok: false, status: 400, json: async () => ({ error: 'Invalid or expired pairing session' }) };
        }
        if (url.endsWith('/auth/session')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ authenticated: false, disabled: false }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });

    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    const encoded = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_bad',
      secret: 'nope',
      candidates: [{ type: 'lan', url: 'http://192.168.1.74:2606' }],
    });
    expect(await controller.redeemPairingLink(encoded)).toBe(false);
    expect(controller.getState().phase).toBe('onboarding');
    expect(controller.getState().error).toContain('配对失败');
    expect(controller.getState().error).not.toContain('密码');
  });

  it('redeemPairing parses Cap-shaped ok+clientToken response', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    setSecureStoreBackend(new MemorySecureStore());
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              clientToken: 'oc_client_from_server',
              server: { label: 'Desk' },
              client: { label: 'phone' },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });
    const result = await redeemPairing(
      { kind: 'direct', url: 'http://192.168.1.74:2606' },
      { pairingId: 'p1', secret: 's1' },
    );
    expect(result).toEqual({
      ok: true,
      clientToken: 'oc_client_from_server',
      serverLabel: 'Desk',
    });
  });
});
