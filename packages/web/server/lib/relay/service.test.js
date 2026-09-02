import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const relayMocks = vi.hoisted(() => ({
  starts: [],
  stops: [],
  identityReads: 0,
}));

vi.mock('./identity.js', () => ({
  createRelayIdentityRuntime: () => ({
    getRelayIdentity: async () => {
      relayMocks.identityReads += 1;
      return {
        serverId: 'server-test',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      };
    },
  }),
}));

vi.mock('./host-client.js', () => ({
  startRelayHost: (options) => {
    relayMocks.starts.push(options.relayUrl);
    const stop = vi.fn(() => relayMocks.stops.push(options.relayUrl));
    return {
      stop,
      getStatus: () => ({ state: 'connecting', lastError: null, connectedClients: 0 }),
    };
  },
}));

import {
  createRelayService,
  DEFAULT_RELAY_URL,
  derivePushSendUrlFromRelayUrl,
  isRelayHostRuntime,
  RELAY_HOST_DESKTOP_ONLY_MESSAGE,
  resolveEffectiveRelayUrl,
} from './service.js';

const createSettingsHarness = () => {
  let settings = {};
  return {
    read: async () => settings,
    write: async (next) => { settings = next; },
    current: () => settings,
  };
};

const createTestRelayService = ({ canHostRelay = true, ...overrides } = {}) => {
  const settings = createSettingsHarness();
  const service = createRelayService({
    crypto: {},
    readSettingsFromDiskMigrated: settings.read,
    writeSettingsToDisk: settings.write,
    getLocalPort: () => 3000,
    canHostRelay: () => canHostRelay,
    ...overrides,
  });
  return { service, settings };
};

describe('derivePushSendUrlFromRelayUrl', () => {
  it('converts wss and ws canonical relay URLs to the fixed push send path', () => {
    expect(derivePushSendUrlFromRelayUrl('wss://relay.openchamber.dev/ws')).toBe(
      'https://relay.openchamber.dev/v1/push/send',
    );
    expect(derivePushSendUrlFromRelayUrl('ws://127.0.0.1:8787/custom')).toBe(
      'http://127.0.0.1:8787/v1/push/send',
    );
    expect(derivePushSendUrlFromRelayUrl('wss://relay.example:8443/any/path?token=secret#frag')).toBe(
      'https://relay.example:8443/v1/push/send',
    );
  });

  it('rejects userinfo and non-ws(s) URLs', () => {
    expect(derivePushSendUrlFromRelayUrl('wss://user:pass@relay.example/ws')).toBeNull();
    expect(derivePushSendUrlFromRelayUrl('https://relay.openchamber.dev/ws')).toBeNull();
    expect(derivePushSendUrlFromRelayUrl('http://relay.example/v1/push/send')).toBeNull();
    expect(derivePushSendUrlFromRelayUrl('')).toBeNull();
    expect(derivePushSendUrlFromRelayUrl(null)).toBeNull();
  });
});

describe('resolveEffectiveRelayUrl', () => {
  afterEach(() => {
    delete process.env.OPENCHAMBER_RELAY_URL;
  });

  it('prefers a valid env URL, then settings, then the default', () => {
    expect(resolveEffectiveRelayUrl()).toBe(DEFAULT_RELAY_URL);
    expect(
      resolveEffectiveRelayUrl({
        settings: { privateRelay: { relayUrl: 'wss://settings.example/ws' } },
      }),
    ).toBe('wss://settings.example/ws');

    process.env.OPENCHAMBER_RELAY_URL = 'wss://env.example/ws?x=1#frag';
    expect(
      resolveEffectiveRelayUrl({
        settings: { privateRelay: { relayUrl: 'wss://settings.example/ws' } },
      }),
    ).toBe('wss://env.example/ws');
  });

  it('ignores an invalid env URL and falls through to settings', () => {
    process.env.OPENCHAMBER_RELAY_URL = 'https://not-a-relay.example/ws';
    expect(
      resolveEffectiveRelayUrl({
        settings: { privateRelay: { relayUrl: 'wss://settings.example/ws' } },
      }),
    ).toBe('wss://settings.example/ws');
  });
});

describe('relay service pairing endpoint', () => {
  afterEach(() => {
    relayMocks.starts.length = 0;
    relayMocks.stops.length = 0;
    relayMocks.identityReads = 0;
    delete process.env.OPENCHAMBER_RELAY_URL;
  });

  it('switches the Host, persists the endpoint, and embeds it in the pairing candidate', async () => {
    const { service, settings } = createTestRelayService();

    const initial = await service.ensureEnabledForPairing();
    expect(initial.relayUrl).toBe(DEFAULT_RELAY_URL);

    const custom = await service.ensureEnabledForPairing('wss://relay.example/custom');
    expect(custom.relayUrl).toBe('wss://relay.example/custom');
    expect(relayMocks.starts).toEqual([DEFAULT_RELAY_URL, 'wss://relay.example/custom']);
    expect(relayMocks.stops).toEqual([DEFAULT_RELAY_URL]);
    expect(settings.current()).toMatchObject({
      privateRelay: { enabled: true, relayUrl: 'wss://relay.example/custom' },
    });
  });

  it('strips query and fragment before persisting a custom endpoint', async () => {
    const { service, settings } = createTestRelayService();

    const candidate = await service.ensureEnabledForPairing('wss://relay.example/custom?token=secret#frag');
    expect(candidate.relayUrl).toBe('wss://relay.example/custom');
    expect(settings.current()).toMatchObject({
      privateRelay: { enabled: true, relayUrl: 'wss://relay.example/custom' },
    });
  });

  it('rejects userinfo in a custom endpoint without falling back to the default', async () => {
    const { service, settings } = createTestRelayService();

    await expect(service.ensureEnabledForPairing('wss://user:pass@relay.example/ws')).rejects.toMatchObject({
      message: 'Relay URL must use ws:// or wss://',
      statusCode: 400,
    });
    expect(settings.current()).toEqual({});
    expect(relayMocks.starts).toEqual([]);
  });

  it('keeps an environment-pinned endpoint authoritative', async () => {
    process.env.OPENCHAMBER_RELAY_URL = 'wss://pinned.example/ws';
    const { service } = createTestRelayService();

    const candidate = await service.ensureEnabledForPairing('wss://ignored.example/ws');
    expect(candidate.relayUrl).toBe('wss://pinned.example/ws');
    expect(relayMocks.starts).toEqual(['wss://pinned.example/ws']);
  });

  it('returns 400 from enable when the endpoint embeds userinfo instead of falling back', async () => {
    const { service, settings } = createTestRelayService();
    const app = express();
    service.registerRoutes(app);

    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://user:pass@relay.example/ws' })
      .expect(400, { error: 'Relay URL must use ws:// or wss://' });

    expect(settings.current()).toEqual({});
    expect(relayMocks.starts).toEqual([]);
  });

  it('persists a canonical enable endpoint without query or fragment', async () => {
    const { service, settings } = createTestRelayService();
    const app = express();
    service.registerRoutes(app);

    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://relay.example/custom?x=1#frag' })
      .expect(200);

    expect(settings.current()).toMatchObject({
      privateRelay: { enabled: true, relayUrl: 'wss://relay.example/custom' },
    });
    expect(relayMocks.starts).toEqual(['wss://relay.example/custom']);
  });

  it('invokes onRelayUrlChanged only when the canonical URL actually changes', async () => {
    const onRelayUrlChanged = vi.fn(async () => {});
    const { service } = createTestRelayService({ onRelayUrlChanged });

    await service.ensureEnabledForPairing();
    expect(onRelayUrlChanged).not.toHaveBeenCalled();

    await service.ensureEnabledForPairing('wss://relay.example/custom');
    expect(onRelayUrlChanged).toHaveBeenCalledTimes(1);

    await service.ensureEnabledForPairing('wss://relay.example/custom?x=1#frag');
    expect(onRelayUrlChanged).toHaveBeenCalledTimes(1);

    const app = express();
    service.registerRoutes(app);
    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://relay.example/other' })
      .expect(200);
    expect(onRelayUrlChanged).toHaveBeenCalledTimes(2);

    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://relay.example/other' })
      .expect(200);
    expect(onRelayUrlChanged).toHaveBeenCalledTimes(2);
  });

  it('does not invoke onRelayUrlChanged for an env-pinned relay and still uses the pin', async () => {
    process.env.OPENCHAMBER_RELAY_URL = 'wss://pinned.example/ws';
    const onRelayUrlChanged = vi.fn(async () => {});
    const { service } = createTestRelayService({ onRelayUrlChanged });
    const app = express();
    service.registerRoutes(app);

    const candidate = await service.ensureEnabledForPairing('wss://ignored.example/ws');
    expect(candidate.relayUrl).toBe('wss://pinned.example/ws');
    expect(onRelayUrlChanged).not.toHaveBeenCalled();

    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://ignored.example/ws' })
      .expect(200);
    expect(onRelayUrlChanged).not.toHaveBeenCalled();
    expect((await service.getStatus()).relayUrl).toBe('wss://pinned.example/ws');
  });

  it('continues the relay switch when onRelayUrlChanged fails', async () => {
    const onRelayUrlChanged = vi.fn(async () => {
      throw new Error('push relay unavailable');
    });
    const logger = { warn: vi.fn() };
    const { service } = createTestRelayService({ onRelayUrlChanged, logger });

    await expect(service.ensureEnabledForPairing('wss://relay.example/custom')).resolves.toMatchObject({
      relayUrl: 'wss://relay.example/custom',
    });
    expect(onRelayUrlChanged).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('push token re-register failed'));
    expect(relayMocks.starts).toEqual(['wss://relay.example/custom']);
  });
});

describe('relay host runtime gate', () => {
  afterEach(() => {
    relayMocks.starts.length = 0;
    relayMocks.stops.length = 0;
    relayMocks.identityReads = 0;
  });

  it('does not start a host, claim, mint identity, or rewrite settings when reconcile runs off host runtime', async () => {
    const write = vi.fn(async (next) => next);
    const { service, settings } = createTestRelayService({
      canHostRelay: false,
      writeSettingsToDisk: write,
      hasRelayDemand: async () => true,
    });

    await service.reconcile();

    expect(relayMocks.starts).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(settings.current()).toEqual({});
    await expect(service.getStatus()).resolves.toEqual({
      enabled: false,
      hostAllowed: false,
      state: 'unavailable',
      serverId: null,
      connectedClients: 0,
      lastError: RELAY_HOST_DESKTOP_ONLY_MESSAGE,
    });
    await expect(service.getServerId()).resolves.toBeNull();
    expect(relayMocks.identityReads).toBe(0);
  });

  it('includes the public E2EE trust anchor on host-capable status', async () => {
    const { service } = createTestRelayService();
    await expect(service.getStatus()).resolves.toMatchObject({
      hostAllowed: true,
      serverId: 'server-test',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
  });

  it('refuses relay pairing and enable off host runtime', async () => {
    const { service, settings } = createTestRelayService({ canHostRelay: false });
    const app = express();
    service.registerRoutes(app);

    await expect(service.ensureEnabledForPairing()).rejects.toMatchObject({
      message: RELAY_HOST_DESKTOP_ONLY_MESSAGE,
      statusCode: 403,
    });
    await expect(service.getPairingCandidate()).resolves.toBeNull();

    await request(app)
      .post('/api/openchamber/relay/enable')
      .send({})
      .expect(403, { error: RELAY_HOST_DESKTOP_ONLY_MESSAGE });

    await request(app)
      .post('/api/openchamber/relay/disable')
      .send({})
      .expect(403, { error: RELAY_HOST_DESKTOP_ONLY_MESSAGE });

    expect(relayMocks.starts).toEqual([]);
    expect(settings.current()).toEqual({});
  });

  it('defaults canHostRelay from OPENCHAMBER_RUNTIME=desktop', async () => {
    const previous = process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    try {
      expect(isRelayHostRuntime()).toBe(true);
      const settings = createSettingsHarness();
      const service = createRelayService({
        crypto: {},
        readSettingsFromDiskMigrated: settings.read,
        writeSettingsToDisk: settings.write,
        getLocalPort: () => 3000,
      });
      await service.ensureEnabledForPairing();
      expect(relayMocks.starts).toEqual([DEFAULT_RELAY_URL]);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_RUNTIME;
      else process.env.OPENCHAMBER_RUNTIME = previous;
    }
  });

  it('defaults canHostRelay from OPENCHAMBER_RUNTIME=ssh-remote', async () => {
    const previous = process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_RUNTIME = 'ssh-remote';
    try {
      expect(isRelayHostRuntime()).toBe(true);
      const settings = createSettingsHarness();
      const service = createRelayService({
        crypto: {},
        readSettingsFromDiskMigrated: settings.read,
        writeSettingsToDisk: settings.write,
        getLocalPort: () => 3000,
      });
      await service.ensureEnabledForPairing();
      expect(relayMocks.starts).toEqual([DEFAULT_RELAY_URL]);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_RUNTIME;
      else process.env.OPENCHAMBER_RUNTIME = previous;
    }
  });

  it('keeps an ssh-remote opt-in host running when demand is absent', async () => {
    const previous = process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_RUNTIME = 'ssh-remote';
    try {
      const settings = createSettingsHarness();
      await settings.write({
        privateRelay: { enabled: true, relayUrl: DEFAULT_RELAY_URL },
      });
      const service = createRelayService({
        crypto: {},
        readSettingsFromDiskMigrated: settings.read,
        writeSettingsToDisk: settings.write,
        getLocalPort: () => 3000,
        hasRelayDemand: async () => false,
      });

      await service.reconcile();

      expect(relayMocks.starts).toEqual([DEFAULT_RELAY_URL]);
      expect(settings.current()).toMatchObject({
        privateRelay: { enabled: true, relayUrl: DEFAULT_RELAY_URL },
      });
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_RUNTIME;
      else process.env.OPENCHAMBER_RUNTIME = previous;
    }
  });

  it('defaults canHostRelay to false when OPENCHAMBER_RUNTIME is not a host runtime', async () => {
    const previous = process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_RUNTIME;
    try {
      expect(isRelayHostRuntime()).toBe(false);
      const settings = createSettingsHarness();
      const service = createRelayService({
        crypto: {},
        readSettingsFromDiskMigrated: settings.read,
        writeSettingsToDisk: settings.write,
        getLocalPort: () => 3000,
      });
      await expect(service.ensureEnabledForPairing()).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(relayMocks.starts).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_RUNTIME;
      else process.env.OPENCHAMBER_RUNTIME = previous;
    }
  });
});
