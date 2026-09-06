import { describe, expect, test, vi } from 'vitest';

import {
  createMemoryHost,
  createMemoryJsonStore,
  createMemorySecureStore,
  jsonResponse,
} from '../host/memory.ts';
import { createLynxConnectionController } from './controller.ts';
import { encodePairingConnectionPayload, buildPairingConnectionPayload } from './pairing.ts';
import { parseConnectionPayload } from './qr.ts';
import { prefixedTokenKey } from './store.ts';
import { LYNX_METADATA_STORAGE_KEY } from './types.ts';
import { secureTokenKeyOf } from './urls.ts';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;
const relay = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_1',
  hostEncPubJwk,
};

const pairing = buildPairingConnectionPayload({
  pairingId: 'pair_abc',
  secret: 'one-time',
  label: 'Studio',
  candidates: [
    { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
    { type: 'relay', relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk, priority: 30 },
  ],
});

describe('createLynxConnectionController', () => {
  test('resolveLaunch holds splash then auto-connects via GET /health + /auth/session', async () => {
    const metadata = createMemoryJsonStore();
    const secure = createMemorySecureStore();
    const storeHost = createMemoryHost({ metadataStore: metadata, secureStore: secure });
    const bootstrap = createLynxConnectionController(storeHost);
    await bootstrap.saveConnection({
      label: 'Home',
      candidates: [{ kind: 'direct', url: 'http://192.168.1.9:2606' }],
      clientToken: 'saved-token',
    });

    const binds: Array<{ token: string | null; url?: string }> = [];
    const logs: Array<{ step: string; detail?: Record<string, unknown> }> = [];
    const controller = createLynxConnectionController({
      ...createMemoryHost({ metadataStore: metadata, secureStore: secure }),
      request: async (url) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
        return jsonResponse(404, null);
      },
      bindRuntime: (bind) => {
        binds.push({ token: bind.clientToken, url: bind.transport.kind === 'direct' ? bind.transport.url : undefined });
      },
      logger: {
        info: (step, detail) => logs.push({ step, detail }),
        warn: (step, detail) => logs.push({ step, detail }),
      },
    });

    expect(controller.snapshot().phase).toBe('resolving');
    expect(controller.snapshot().autoConnectLabel).toBe('Home');
    const connected = await controller.resolveLaunch();
    expect(connected).toBe(true);
    expect(controller.snapshot().phase).toBe('connected');
    expect(binds[0]).toEqual({ token: 'saved-token', url: 'http://192.168.1.9:2606' });
    expect(JSON.stringify(logs)).not.toContain('saved-token');
  });

  test('redeem v2 hits official pairing/redeem once and persists LAN+relay', async () => {
    const redeemBodies: string[] = [];
    const secure = createMemorySecureStore();
    const metadata = createMemoryJsonStore();
    const controller = createLynxConnectionController({
      ...createMemoryHost({ metadataStore: metadata, secureStore: secure }),
      request: async (url, init) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok', serverId: 'srv_1' });
        if (url.endsWith('/api/client-auth/pairing/redeem')) {
          redeemBodies.push(init?.body ?? '');
          return jsonResponse(200, {
            ok: true,
            clientToken: 'issued-token',
            server: { label: 'Studio Mac' },
          });
        }
        return jsonResponse(404, null);
      },
    });

    await controller.redeemPairing(pairing);
    expect(controller.snapshot().phase).toBe('connected');
    expect(controller.snapshot().connections[0]?.candidates.map((candidate) => candidate.kind)).toEqual(['direct', 'relay']);
    expect(controller.snapshot().connections[0]?.candidates[1]).toEqual({ kind: 'relay', relay });
    const raw = JSON.parse(metadata.read(LYNX_METADATA_STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
    expect(raw[0]?.clientToken).toBeUndefined();
    const key = prefixedTokenKey(secureTokenKeyOf(controller.snapshot().connections[0]!));
    expect(secure.snapshot()[key]).toBe('issued-token');
    expect(redeemBodies).toHaveLength(1);
    const body = JSON.parse(redeemBodies[0] || '{}') as { pairingId?: string; secret?: string; clientKind?: string };
    expect(body).toMatchObject({ pairingId: 'pair_abc', secret: 'one-time', clientKind: 'mobile' });
  });

  test('does not invent a nearby redeem path', async () => {
    const urls: string[] = [];
    const controller = createLynxConnectionController({
      ...createMemoryHost(),
      request: async (url) => {
        urls.push(url);
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/api/client-auth/pairing/redeem')) {
          return jsonResponse(200, { ok: true, clientToken: 't' });
        }
        return jsonResponse(404, null);
      },
    });
    await controller.redeemPairing(buildPairingConnectionPayload({
      pairingId: 'pair_1',
      secret: 's',
      candidates: [{ type: 'lan', url: 'http://10.0.0.8:2606' }],
    }));
    expect(urls.some((url) => url.includes('/nearby'))).toBe(false);
    expect(urls.some((url) => url.endsWith('/api/client-auth/pairing/redeem'))).toBe(true);
  });

  test('password unlock posts issueClientToken and stores the bearer', async () => {
    const secure = createMemorySecureStore();
    const controller = createLynxConnectionController({
      ...createMemoryHost({ secureStore: secure }),
      request: async (url, init) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/auth/session') && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse(401, { authenticated: false });
        }
        if (url.endsWith('/auth/session') && init?.method === 'POST') {
          const body = JSON.parse(init.body || '{}') as { issueClientToken?: boolean; password?: string };
          expect(body.issueClientToken).toBe(true);
          expect(body.password).toBe('hunter2');
          return jsonResponse(200, { authenticated: true, clientToken: 'new-token' });
        }
        return jsonResponse(404, null);
      },
    });

    await controller.connect({ url: 'http://192.168.1.9:2606', label: 'Home' });
    expect(controller.snapshot().phase).toBe('password');
    await controller.submitPassword('hunter2');
    expect(controller.snapshot().phase).toBe('connected');
    expect(Object.values(secure.snapshot())).toContain('new-token');
  });

  test('delete removes metadata and the secure token', async () => {
    const secure = createMemorySecureStore();
    const controller = createLynxConnectionController(createMemoryHost({ secureStore: secure }));
    const saved = await controller.saveConnection({
      label: 'Home',
      url: 'http://192.168.1.9:2606',
      clientToken: 'tok',
    });
    expect(saved).not.toBeNull();
    expect(Object.keys(secure.snapshot())).toHaveLength(1);
    await controller.removeConnection(saved!.id);
    expect(controller.snapshot().connections).toEqual([]);
    expect(secure.snapshot()).toEqual({});
  });

  test('scanAndConnect parses a pairing QR and a bare URL; host camera is optional', async () => {
    const controller = createLynxConnectionController({
      ...createMemoryHost(),
      request: async (url) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/api/client-auth/pairing/redeem')) {
          return jsonResponse(200, { ok: true, clientToken: 'from-qr' });
        }
        if (url.endsWith('/auth/session')) return jsonResponse(200, { authenticated: true, scope: 'client' });
        return jsonResponse(404, null);
      },
      scanQr: async () => ({ status: 'ok', raw: encodePairingConnectionPayload(pairing) }),
    });
    await controller.scanAndConnect();
    expect(controller.snapshot().phase).toBe('connected');

    const noCamera = createLynxConnectionController(createMemoryHost());
    await noCamera.scanAndConnect();
    expect(noCamera.snapshot().error).toBe('scan-unsupported');
  });

  test('applyDeepLinkUrl redeem v2 and ignores v1', async () => {
    const controller = createLynxConnectionController({
      ...createMemoryHost(),
      request: async (url) => {
        if (url.endsWith('/health')) return jsonResponse(200, { status: 'ok' });
        if (url.endsWith('/api/client-auth/pairing/redeem')) {
          return jsonResponse(200, { ok: true, clientToken: 'deeplink' });
        }
        return jsonResponse(404, null);
      },
    });
    const applied = controller.applyDeepLinkUrl(encodePairingConnectionPayload(pairing));
    expect(applied.kind === 'pairing-started' || applied.kind === 'pairing-queued').toBe(true);
    await vi.waitFor(() => {
      expect(controller.snapshot().phase).toBe('connected');
    });
    expect(controller.applyDeepLinkUrl('openchamber://connect?v=1&token=nope').kind).toBe('ignored');
  });
});

describe('QR / paste parse', () => {
  test('accepts a v2 pairing link and a bare http URL; rejects v1', () => {
    expect(parseConnectionPayload(encodePairingConnectionPayload(pairing))?.kind).toBe('pairing');
    expect(parseConnectionPayload('https://oc.example')).toEqual({ kind: 'url', url: 'https://oc.example' });
    expect(parseConnectionPayload('openchamber://connect?v=1&token=secret')).toBeNull();
    expect(parseConnectionPayload('openchamber://session/abc')).toBeNull();
  });
});
