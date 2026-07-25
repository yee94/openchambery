import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import http from 'node:http';

import { createRelayService } from './service.js';

const withService = async (run, deps = {}) => {
  let settings = {};
  const service = createRelayService({
    crypto: await import('node:crypto'),
    readSettingsFromDiskMigrated: async () => structuredClone(settings),
    writeSettingsToDisk: async (next) => {
      settings = structuredClone(next);
    },
    readSettingsStrict: async () => structuredClone(settings),
    getLocalPort: () => 4096,
    hasRelayDemand: async () => false,
    logger: { warn: () => {} },
    hapiConnectWaitMs: deps.hapiConnectWaitMs ?? 200,
    ...deps,
  });
  const app = express();
  service.registerRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ service, base, getSettings: () => settings, setSettings: (s) => { settings = s; } });
  } finally {
    service.stop();
    await new Promise((resolve) => server.close(resolve));
  }
};

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const getJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return { status: response.status, body: await response.json().catch(() => null) };
};

describe('relay service HAPI private-relay config', () => {
  const prevEnv = process.env.OPENCHAMBER_RELAY_URL;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.OPENCHAMBER_RELAY_URL;
    else process.env.OPENCHAMBER_RELAY_URL = prevEnv;
  });

  test('enable accepts transport+accessToken and persists them', async () => {
    // Short wait so fake hub dial fails with timeout (non-2xx) — we still
    // assert persistence happened before the readiness gate rejects.
    await withService(async ({ base, getSettings, service }) => {
      // Seed config by writing settings then calling configure path via enable
      // with a local fake that never connects → 504, but token is stored.
      const result = await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
        transport: 'hapi',
        accessToken: '  cli_tok:ns  ',
      });
      // Fake hub never connects within hapiConnectWaitMs → non-2xx readiness fail.
      expect(result.status).not.toBe(200);
      expect(getSettings().privateRelay).toEqual({
        enabled: true,
        relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
        transport: 'hapi',
        accessToken: 'cli_tok:ns',
        classicRelayUrl: 'wss://relay.openchamber.dev/ws',
      });

      // Status never echoes the token; hasAccessToken is true.
      const status = await service.getStatus();
      expect(status.transport).toBe('hapi');
      expect(status.hasAccessToken).toBe(true);
      expect(status.accessToken).toBeUndefined();
      expect(JSON.stringify(status)).not.toContain('cli_tok:ns');

      // Pairing candidate carries token only while transport is hapi.
      const candidate = await service.ensureEnabledForPairing();
      expect(candidate.transport).toBe('hapi');
      expect(candidate.accessToken).toBe('cli_tok:ns');
      expect(candidate.type).toBe('relay');
    }, { hapiConnectWaitMs: 50 });
  });

  test('enable rejects hapi transport without accessToken (and without stored token)', async () => {
    await withService(async ({ base }) => {
      const result = await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
        transport: 'hapi',
      });
      expect(result.status).toBe(400);
      expect(result.body?.error).toMatch(/accessToken/i);
    });
  });

  test('enable reuses stored HAPI accessToken when body omits it', async () => {
    await withService(async ({ base, getSettings, setSettings }) => {
      setSettings({
        privateRelay: {
          enabled: false,
          relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
          transport: 'hapi',
          accessToken: 'stored-secret-tok',
          classicRelayUrl: 'wss://relay.openchamber.dev/ws',
        },
      });
      const result = await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
        transport: 'hapi',
      });
      // Still times out on fake hub, but must not 400 for missing token.
      expect(result.status).not.toBe(400);
      expect(getSettings().privateRelay.accessToken).toBe('stored-secret-tok');
    }, { hapiConnectWaitMs: 50 });
  });

  test('status returns hasAccessToken boolean and never the raw token', async () => {
    await withService(async ({ base, service, setSettings }) => {
      setSettings({
        privateRelay: {
          enabled: true,
          relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
          transport: 'hapi',
          accessToken: 'secret-token',
        },
      });
      const status = await service.getStatus();
      expect(status.transport).toBe('hapi');
      expect(status.hasAccessToken).toBe(true);
      expect(status.accessToken).toBeUndefined();
      expect(JSON.stringify(status)).not.toContain('secret-token');

      const httpStatus = await getJson(`${base}/api/openchamber/relay/status`);
      expect(httpStatus.status).toBe(200);
      expect(httpStatus.body?.hasAccessToken).toBe(true);
      expect(httpStatus.body?.accessToken).toBeUndefined();
      expect(JSON.stringify(httpStatus.body)).not.toContain('secret-token');
    });
  });

  test('HAPI→classic clears token from host config, status, and pairing candidate', async () => {
    await withService(async ({ base, getSettings, service, setSettings }) => {
      setSettings({
        privateRelay: {
          enabled: true,
          relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
          transport: 'hapi',
          accessToken: 'hapi-secret-xyz',
          classicRelayUrl: 'wss://my-classic.example/ws',
        },
      });

      const classic = await postJson(`${base}/api/openchamber/relay/classic`, { enabled: true });
      // Classic enable does not wait for connected (no HAPI gate).
      expect(classic.status).toBe(200);
      expect(classic.body?.transport).toBeUndefined();
      expect(classic.body?.hasAccessToken).toBe(false);
      expect(JSON.stringify(classic.body)).not.toContain('hapi-secret-xyz');

      const stored = getSettings().privateRelay;
      expect(stored.transport).toBeUndefined();
      expect(stored.accessToken).toBeUndefined();
      expect(stored.relayUrl).toBe('wss://my-classic.example/ws');
      expect(stored.classicRelayUrl).toBe('wss://my-classic.example/ws');

      const status = await service.getStatus();
      expect(status.transport).toBeUndefined();
      expect(status.hasAccessToken).toBe(false);
      expect(status.relayUrl).toBe('wss://my-classic.example/ws');
      expect(JSON.stringify(status)).not.toContain('hapi-secret-xyz');

      // Force enabled for pairing candidate
      await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://my-classic.example/ws',
      });
      const candidate = await service.ensureEnabledForPairing();
      expect(candidate.transport).toBeUndefined();
      expect(candidate.accessToken).toBeUndefined();
      expect(candidate.relayUrl).toBe('wss://my-classic.example/ws');
      expect(JSON.stringify(candidate)).not.toContain('hapi-secret-xyz');
    }, { hapiConnectWaitMs: 50 });
  });

  test('entering HAPI preserves classicRelayUrl from prior classic relayUrl', async () => {
    await withService(async ({ base, getSettings }) => {
      // First enable classic-ish URL without transport
      await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://self-hosted.example/ws',
      });
      expect(getSettings().privateRelay.relayUrl).toBe('wss://self-hosted.example/ws');
      expect(getSettings().privateRelay.transport).toBeUndefined();

      // Switch to HAPI — should stash classic URL
      await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
        transport: 'hapi',
        accessToken: 'tok',
      });
      expect(getSettings().privateRelay.classicRelayUrl).toBe('wss://self-hosted.example/ws');
      expect(getSettings().privateRelay.transport).toBe('hapi');
    }, { hapiConnectWaitMs: 50 });
  });

  test('HAPI readiness gate returns non-2xx on timeout so UI must not pair', async () => {
    await withService(async ({ base }) => {
      const result = await postJson(`${base}/api/openchamber/relay/enable`, {
        relayUrl: 'wss://127.0.0.1:1/api/openchamber/relay/ws',
        transport: 'hapi',
        accessToken: 'tok',
      });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body?.error).toMatch(/connect|time|timeout|HAPI/i);
    }, { hapiConnectWaitMs: 80 });
  });
});
