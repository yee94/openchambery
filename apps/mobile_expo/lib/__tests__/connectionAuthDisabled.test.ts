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
import { ConnectionController, formatRedeemAuthRequiredError } from '@/lib/connectionController';
import { MemoryMetaStore, setMetaStoreBackend } from '@/lib/metaStore';
import { MemorySecureStore, setSecureStoreBackend, type SecureStoreBackend } from '@/lib/secureStore';
import { resetDeviceIdCacheForTests } from '@/lib/deviceId';
import { encodePairingConnectionPayload } from '@/lib/connectionPayload';
import { t } from '@/lib/i18n';

afterEach(() => {
  setConnectionHttp(null);
  setOpenRelaySession(null);
  setMetaStoreBackend(null);
  setSecureStoreBackend(null);
  resetDeviceIdCacheForTests();
});

describe('parsePairingRedeemToken', () => {
  it('reads only top-level clientToken string (Cap parity)', () => {
    expect(parsePairingRedeemToken({ ok: true, clientToken: '  tok-a  ' })).toBe('tok-a');
  });

  it('does not invent nested token parsers Cap lacks', () => {
    expect(parsePairingRedeemToken({ token: 'tok-b' })).toBe('');
    expect(parsePairingRedeemToken({ client: { token: 'tok-c' } })).toBe('');
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

describe('redeem pairing Cap parity', () => {
  it('uses Cap redeem body labels and authRequired on HTTP fail (no pairingFailed invent)', async () => {
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
    // Cap does NOT tokenless-adopt after redeem fail even when auth-disabled.
    expect(await controller.redeemPairingLink(encoded)).toBe(false);
    expect(controller.getState().phase).toBe('onboarding');
    expect(controller.getState().error).toBe(`${t('mobile.connect.error.authRequired')} (HTTP 400)`);
    expect(controller.getState().error).toContain(t('mobile.connect.error.authRequired'));
    expect(controller.getState().error).not.toContain('已过期');
    expect(controller.getState().error).not.toContain('pairingFailed');
    expect(redeemBody).toBeTruthy();
    const parsed = JSON.parse(redeemBody!);
    expect(parsed.clientKind).toBe('mobile');
    expect(parsed.clientLabel).toBe('OpenChamber Mobile');
    expect(parsed.deviceName).toBe('OpenChamber Mobile');
    expect(parsed).toHaveProperty('dedupeKey');
    expect(String(parsed.dedupeKey)).toMatch(/^mobile:/);
  });

  it('surfaces authRequired (not pairingFailed) when redeem fails and auth is enabled', async () => {
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
    expect(controller.getState().error).toBe(`${t('mobile.connect.error.authRequired')} (HTTP 400)`);
    expect(controller.getState().error).not.toContain('配对失败');
  });

  it('aborts adopt when SecureStore write fails after token issued', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    const failing: SecureStoreBackend = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error('keystore unavailable');
      },
      deleteItem: async () => undefined,
    };
    setSecureStoreBackend(failing);
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, clientToken: 'oc_client_issued' }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });

    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    const encoded = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_ok',
      secret: 'secret',
      candidates: [{ type: 'lan', url: 'http://192.168.1.74:2606' }],
    });
    expect(await controller.redeemPairingLink(encoded)).toBe(false);
    expect(controller.getState().phase).toBe('onboarding');
    expect(controller.getState().active).toBeNull();
    expect(controller.getState().error).toBe(t('mobile.connect.error.authRequired'));
  });

  it('redeemPairing parses Cap-shaped ok+clientToken response only', async () => {
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

  it('rejects nested-only token bodies Cap would reject', async () => {
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, token: 'nested-only', client: { token: 'also-nested' } }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });
    const result = await redeemPairing(
      { kind: 'direct', url: 'http://192.168.1.74:2606' },
      { pairingId: 'p1', secret: 's1' },
    );
    expect(result).toEqual({ ok: false, reason: 'no-token', status: 200 });
  });

  it('surfaces HTTP status on redeem http fail', async () => {
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });
    const result = await redeemPairing(
      { kind: 'direct', url: 'http://192.168.1.74:2606' },
      { pairingId: 'p1', secret: 's1' },
    );
    expect(result).toEqual({ ok: false, reason: 'http', status: 503 });
  });

  it('adopts after redeem when SecureStore enforces expo charset (relay runtime key)', async () => {
    setMetaStoreBackend(new MemoryMetaStore());
    const store = new Map<string, string>();
    const EXPO_KEY = /^[\w.-]+$/;
    setSecureStoreBackend({
      getItem: async (key) => {
        if (!EXPO_KEY.test(key)) throw new Error('Invalid key provided to SecureStore');
        return store.get(key) ?? null;
      },
      setItem: async (key, value) => {
        if (!EXPO_KEY.test(key)) throw new Error('Invalid key provided to SecureStore');
        store.set(key, value);
      },
      deleteItem: async (key) => {
        if (!EXPO_KEY.test(key)) throw new Error('Invalid key provided to SecureStore');
        store.delete(key);
      },
    });
    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ serverId: 'srv_test' }) };
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, clientToken: 'oc_client_issued', server: { label: 'Desk' } }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });
    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    const encoded = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_ok',
      secret: 'secret',
      label: 'Desk',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.74:2606' },
        {
          type: 'relay',
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_test',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
          grant: 'grant-1',
        },
      ],
    });
    expect(await controller.redeemPairingLink(encoded)).toBe(true);
    expect(controller.getState().phase).toBe('connected');
    expect(controller.getState().active?.clientToken).toBe('oc_client_issued');
    expect(controller.getState().error).toBeNull();
  });
});

describe('formatRedeemAuthRequiredError', () => {
  it('keeps Cap authRequired copy and appends HTTP status', () => {
    expect(formatRedeemAuthRequiredError({ ok: false, reason: 'http', status: 401 })).toBe(
      `${t('mobile.connect.error.authRequired')} (HTTP 401)`,
    );
    expect(formatRedeemAuthRequiredError({ ok: false, reason: 'unreachable' })).toBe(
      `${t('mobile.connect.error.authRequired')} (unreachable)`,
    );
    expect(formatRedeemAuthRequiredError({ ok: false, reason: 'no-token' })).toBe(
      `${t('mobile.connect.error.authRequired')} (no-token)`,
    );
  });
});

