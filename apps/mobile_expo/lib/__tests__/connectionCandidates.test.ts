import { describe, expect, it } from 'vitest';

import {
  pairingCandidatesToMobile,
  parseTransportCandidates,
  probeConnectionCandidates,
  probeOk,
  probeUnreachable,
  serializeTransportCandidates,
  RELAY_RACE_HEADSTART_MS,
} from '@/lib/connectionCandidates';
import {
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  type PairingConnectionPayload,
} from '@/lib/connectionPayload';
import { ConnectionController } from '@/lib/connectionController';
import { MemoryMetaStore, setMetaStoreBackend } from '@/lib/metaStore';
import { MemorySecureStore, setSecureStoreBackend } from '@/lib/secureStore';
import { setConnectionHttp, setOpenRelaySession } from '@/lib/connectionApi';
import { resetDeviceIdCacheForTests } from '@/lib/deviceId';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey;

describe('probeConnectionCandidates', () => {
  it('relay-only skips the 1.5s headstart and never probes LAN', async () => {
    let waited = false;
    let lanProbed = false;
    const started = Date.now();
    const result = await probeConnectionCandidates({
      hasDirect: false,
      hasRelay: true,
      probeDirects: async () => {
        lanProbed = true;
        return probeUnreachable();
      },
      probeRelay: async () => probeOk('relay'),
      headstartMs: 5_000,
      wait: async (ms) => {
        waited = true;
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(result.status).toBe('ok');
    expect(result.value).toBe('relay');
    expect(lanProbed).toBe(false);
    expect(waited).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('LAN wins inside headstart without starting relay', async () => {
    let relayStarted = false;
    let resolveLan!: (v: ReturnType<typeof probeOk<string>>) => void;
    const lan = new Promise<ReturnType<typeof probeOk<string>>>((resolve) => {
      resolveLan = resolve;
    });
    const future = probeConnectionCandidates({
      hasDirect: true,
      hasRelay: true,
      probeDirects: () => lan,
      probeRelay: async () => {
        relayStarted = true;
        return probeOk('relay');
      },
      headstartMs: 40,
    });
    resolveLan(probeOk('lan'));
    const result = await future;
    expect(result.status).toBe('ok');
    expect(result.value).toBe('lan');
    expect(relayStarted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(relayStarted).toBe(false);
  });

  it('exports the official 1500ms headstart constant', () => {
    expect(RELAY_RACE_HEADSTART_MS).toBe(1500);
  });
});

describe('pairing payload persist', () => {
  it('round-trips openchamber://connect?v=2 with full lan+relay+grant', () => {
    const payload: PairingConnectionPayload = {
      v: 2,
      pairingId: 'pair_full',
      secret: 'one-time-secret',
      label: 'Studio',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096' },
        {
          type: 'relay',
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_test',
          hostEncPubJwk,
          grant: 'grant-keep',
        },
      ],
    };
    const encoded = encodePairingConnectionPayload(payload);
    expect(encoded.startsWith('openchamber://connect?')).toBe(true);
    const parsed = parsePairingConnectionPayload(encoded);
    expect(parsed?.pairingId).toBe('pair_full');
    expect(parsed?.candidates).toHaveLength(2);
    const relay = parsed?.candidates.find((c) => c.type === 'relay');
    expect(relay && relay.type === 'relay' && relay.grant).toBe('grant-keep');
    expect(relay && relay.type === 'relay' && relay.serverId).toBe('srv_test');
    expect(relay && relay.type === 'relay' && relay.hostEncPubJwk).toEqual(hostEncPubJwk);
  });

  it('persist+reload keeps full lan + relay candidates including grant', () => {
    const mobile = pairingCandidatesToMobile([
      { type: 'lan', url: 'http://192.168.1.20:4096' },
      { type: 'lan', url: 'http://192.168.1.21:4096' },
      {
        type: 'relay',
        relayUrl: 'wss://relay.example/ws',
        serverId: 'srv_test',
        hostEncPubJwk,
        grant: 'grant-1',
      },
    ]);
    expect(mobile.map((c) => c.kind)).toEqual(['direct', 'direct', 'relay']);
    const raw = serializeTransportCandidates(mobile);
    expect(raw).toHaveLength(3);
    const relayRaw = raw[2] as { kind: string; relay: Record<string, unknown> };
    expect(relayRaw.kind).toBe('relay');
    expect(relayRaw.relay.grant).toBe('grant-1');
    expect(relayRaw.relay.serverId).toBe('srv_test');
    expect(Object.keys(relayRaw.relay).sort()).toEqual(['grant', 'hostEncPubJwk', 'relayUrl', 'serverId']);

    const reloaded = parseTransportCandidates(raw);
    expect(reloaded).toHaveLength(3);
    expect(reloaded[2]?.kind === 'relay' && reloaded[2].relay.grant).toBe('grant-1');
  });
});

describe('ConnectionController pairing persist', () => {
  it('connect persists full pairing candidates across reload', async () => {
    const meta = new MemoryMetaStore();
    const secure = new MemorySecureStore();
    setMetaStoreBackend(meta);
    setSecureStoreBackend(secure);
    resetDeviceIdCacheForTests();

    setConnectionHttp({
      request: async (url, init) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200, json: async () => ({ serverId: 'srv_test' }) };
        }
        if (url.endsWith('/api/client-auth/pairing/redeem') && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ clientToken: 'tok-from-redeem', server: { label: 'Studio' } }),
          };
        }
        if (url.endsWith('/auth/session')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ authenticated: true, scope: 'client' }),
          };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });
    setOpenRelaySession(() => {
      throw new Error('relay must not open for LAN-winning pairing in this test');
    });

    const controller = new ConnectionController({ skipAutoConnect: true, headstartMs: 5 });
    await controller.bootstrap();
    const encoded = encodePairingConnectionPayload({
      v: 2,
      pairingId: 'pair_full',
      secret: 'one-time-secret',
      label: 'Studio',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096' },
        {
          type: 'relay',
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_test',
          hostEncPubJwk,
          grant: 'grant-keep',
        },
      ],
    });
    expect(await controller.redeemPairingLink(encoded)).toBe(true);
    expect(controller.getState().phase).toBe('connected');
    expect(controller.activeTransportKind).toBe('direct');
    expect(controller.getState().active?.candidates).toHaveLength(2);
    expect(
      controller.getState().active?.candidates.some(
        (c) => c.kind === 'relay' && c.relay.grant === 'grant-keep',
      ),
    ).toBe(true);

    const again = new ConnectionController({ skipAutoConnect: true });
    await again.bootstrap();
    const saved = again.getState().connections[0];
    expect(saved?.candidates).toHaveLength(2);
    expect(saved?.candidates.some((c) => c.kind === 'relay' && c.relay.grant === 'grant-keep')).toBe(true);

    setConnectionHttp(null);
    setOpenRelaySession(null);
    setMetaStoreBackend(null);
    setSecureStoreBackend(null);
  });

  it('delete-active returns to onboarding', async () => {
    const meta = new MemoryMetaStore();
    const secure = new MemorySecureStore();
    setMetaStoreBackend(meta);
    setSecureStoreBackend(secure);
    resetDeviceIdCacheForTests();
    setConnectionHttp({
      request: async (url) => {
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/auth/session')) {
          return { ok: true, status: 200, json: async () => ({ authenticated: true, scope: 'client', disabled: true }) };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    });

    const controller = new ConnectionController({ skipAutoConnect: true });
    await controller.bootstrap();
    expect(await controller.connectWithUrl({ url: 'http://192.168.1.9:2606', clientToken: 'tok' })).toBe(true);
    const id = controller.getState().active?.connectionId;
    expect(id).toBeTruthy();
    await controller.removeConnection(id!);
    expect(controller.getState().phase).toBe('onboarding');
    expect(controller.getState().active).toBeNull();

    setConnectionHttp(null);
    setMetaStoreBackend(null);
    setSecureStoreBackend(null);
  });
});

// silence unused import in case tree shakes oddly
void (0 as unknown as RelayTunnelClient);
