import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApnsRuntime } from './apns-runtime.js';
import { registerNotificationRoutes } from './routes.js';
import { resolveEffectiveRelayUrl } from '../relay/service.js';
import { createPushRelayServer } from '../../../../relay-server/src/push/index.js';
import { createApnsProvider } from '../../../../relay-server/src/push/apns.js';

// A real P-256 key so the ES256 signing path (direct mode) runs for real.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS_CONFIG = { keyId: 'KEY123', teamId: 'TEAM123', p8: P8, bundleId: 'com.openchamber.app', environment: 'sandbox' };

// In-memory fs so add-then-read reflects within a test.
const createMemoryFs = () => {
  let content = null;
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => {
      if (content == null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }),
    writeFile: vi.fn(async (_path, data) => {
      content = data;
    }),
  };
};

const makeDeps = (overrides = {}) => {
  // Stateful settings so the auto-generated relay signing keypair persists + reads back.
  let settings = {};
  return {
    fsPromises: createMemoryFs(),
    path: { dirname: () => '/tmp' },
    crypto,
    http2: { connect: vi.fn(() => { throw new Error('http2 must not be used in relay mode'); }) },
    APNS_TOKENS_FILE_PATH: '/tmp/apns-tokens.json',
    readSettingsFromDiskMigrated: vi.fn(async () => settings),
    writeSettingsToDisk: vi.fn(async (next) => { settings = next; }),
    resolveEffectiveRelayUrl: async () => resolveEffectiveRelayUrl({ settings }),
    ...overrides,
  };
};

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Mirror of the relay's verifier (crypto.subtle), to prove the server's signatures are valid.
const verifyRelaySignature = async (publicKeyJwk, message, sigB64Url) => {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(Buffer.from(sigB64Url, 'base64url')),
    new TextEncoder().encode(message),
  );
};

const isRegister = ([url]) => String(url).endsWith('/register-token');
const isSend = ([url]) => String(url) === 'https://relay.test/v1/push/send';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCHAMBER_PUSH_RELAY_URL;
  delete process.env.OPENCHAMBER_PUSH_RELAY_DISABLED;
  delete process.env.OPENCHAMBER_RELAY_URL;
  delete process.env.OPENCHAMBER_APNS_KEY_ID;
  delete process.env.OPENCHAMBER_APNS_TEAM_ID;
  delete process.env.OPENCHAMBER_APNS_P8;
  delete process.env.OPENCHAMBER_APNS_BUNDLE_ID;
  delete process.env.OPENCHAMBER_APNS_ENVIRONMENT;
});

describe('apns runtime bundle ID', () => {
  it('defaults to the current product bundle ID when env and settings omit it', async () => {
    process.env.OPENCHAMBER_APNS_KEY_ID = 'KEY123';
    process.env.OPENCHAMBER_APNS_TEAM_ID = 'TEAM123';
    process.env.OPENCHAMBER_APNS_P8 = P8;
    const runtime = createApnsRuntime(makeDeps());
    await expect(runtime.resolveApnsConfig()).resolves.toMatchObject({ bundleId: 'com.yee94.openchamber' });
  });

  it('prefers OPENCHAMBER_APNS_BUNDLE_ID over the default and settings', async () => {
    process.env.OPENCHAMBER_APNS_BUNDLE_ID = 'com.example.app';
    const runtime = createApnsRuntime(
      makeDeps({
        readSettingsFromDiskMigrated: vi.fn(async () => ({
          apnsConfig: { ...APNS_CONFIG, bundleId: 'com.example.settings' },
        })),
      }),
    );
    await expect(runtime.resolveApnsConfig()).resolves.toMatchObject({ bundleId: 'com.example.app' });
  });

  it('prefers settings.apnsConfig.bundleId over the default', async () => {
    const runtime = createApnsRuntime(
      makeDeps({
        readSettingsFromDiskMigrated: vi.fn(async () => ({
          apnsConfig: { ...APNS_CONFIG, bundleId: 'com.example.settings' },
        })),
      }),
    );
    await expect(runtime.resolveApnsConfig()).resolves.toMatchObject({ bundleId: 'com.example.settings' });
  });
});

describe('apns runtime relay mode (default)', () => {
  it('registers tokens (signed) and posts signed generic text, dropping dead tokens', async () => {
    const fetchMock = vi.fn(async (url) =>
      isRegister([url])
        ? jsonResponse({ ok: true })
        : jsonResponse({
            results: [
              { token: 'tokenA', ok: true, drop: false },
              { token: 'tokenDead', ok: false, drop: true },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenDead');

    // Each new token is bound on the relay with a signed register-token call.
    const registerCalls = fetchMock.mock.calls.filter(isRegister);
    expect(registerCalls).toHaveLength(2);
    for (const [url, init] of registerCalls) {
      expect(url).toBe('https://relay.test/v1/push/register-token');
      const body = JSON.parse(init.body);
      expect(body.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
      expect(typeof body.ts).toBe('number');
      expect(body.platform).toBe('ios');
      expect(await verifyRelaySignature(body.publicKeyJwk, `${body.ts}.${body.token}.${body.platform}`, body.sig)).toBe(true);
    }

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions(
      { title: 'Agent response is ready', body: 'My session', badge: 3, tag: 'ready-x', data: { sessionId: 'sess1' } },
      {},
    );

    const sendCall = fetchMock.mock.calls.find(isSend);
    expect(sendCall).toBeTruthy();
    const sent = JSON.parse(sendCall[1].body);
    expect(sendCall[1].headers.authorization).toBeUndefined();
    expect(new Set(sent.tokens)).toEqual(new Set(['tokenA', 'tokenDead']));
    expect(sent.title).toBe('Agent response is ready');
    expect(sent.body).toBe('My session');
    expect(sent.badge).toBe(3);
    expect(sent.data).toEqual({ sessionId: 'sess1' });
    expect(sent.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const sendMessage = `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.title}`;
    expect(await verifyRelaySignature(sent.publicKeyJwk, sendMessage, sent.sig)).toBe(true);

    // tokenDead should have been dropped → next send targets only tokenA.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'x', body: 'y', tag: 't' }, {});
    expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['tokenA']);
  });

  it('reuses one persisted keypair (same serverId) across register + send', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {});

    const keys = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).publicKeyJwk);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.every((k) => k.x === keys[0].x && k.y === keys[0].y)).toBe(true);
    // Keypair was generated + persisted exactly once.
    expect(deps.writeSettingsToDisk).toHaveBeenCalledTimes(1);
  });

  it('no-ops (no relay call) when no tokens are registered', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits relay collapseId when CJK/emoji tags exceed 64 UTF-8 bytes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');

    const sendTag = async (tag) => {
      fetchMock.mockClear();
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag });
      const sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
      return Object.prototype.hasOwnProperty.call(sent, 'collapseId') ? sent.collapseId : undefined;
    };

    const cjkKeep = '会话'.repeat(10); // 60 bytes
    const cjkOmit = '会话'.repeat(11); // 66 bytes
    const emojiKeep = '🎉'.repeat(16); // 64 bytes
    const emojiOmit = '🎉'.repeat(17); // 68 bytes
    expect(Buffer.byteLength(cjkKeep, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(cjkOmit, 'utf8')).toBeGreaterThan(64);
    expect(Buffer.byteLength(emojiKeep, 'utf8')).toBe(64);
    expect(Buffer.byteLength(emojiOmit, 'utf8')).toBeGreaterThan(64);

    expect(await sendTag('ready-x')).toBe('ready-x');
    expect(await sendTag(cjkKeep)).toBe(cjkKeep);
    expect(await sendTag(cjkOmit)).toBeUndefined();
    expect(await sendTag(emojiKeep)).toBe(emojiKeep);
    expect(await sendTag(emojiOmit)).toBeUndefined();
  });
});

describe('apns runtime direct fallback (relay disabled)', () => {
  it('signs an ES256 JWT and sends over http2 when relay is disabled', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const targeted = [];
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          targeted.push(String(headers[':path']).replace('/3/device/', ''));
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: () => {
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(targeted).toEqual(['tokenDirect']);
  });

  it('keeps direct APNs collapse-id within 64 UTF-8 bytes and omits CJK/emoji over the limit', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const collapseIds = [];
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          collapseIds.push(headers['apns-collapse-id']);
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: () => {
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

    const sendTag = async (tag) => {
      collapseIds.length = 0;
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag });
      return collapseIds[0];
    };

    const cjkKeep = '会话'.repeat(10); // 60 bytes
    const cjkOmit = '会话'.repeat(11); // 66 bytes
    const emojiKeep = '🎉'.repeat(16); // 64 bytes
    const emojiOmit = '🎉'.repeat(17); // 68 bytes
    expect(Buffer.byteLength(cjkKeep, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(cjkOmit, 'utf8')).toBeGreaterThan(64);
    expect(Buffer.byteLength(emojiKeep, 'utf8')).toBe(64);
    expect(Buffer.byteLength(emojiOmit, 'utf8')).toBeGreaterThan(64);

    expect(await sendTag('ready-x')).toBe('ready-x');
    expect(await sendTag(cjkKeep)).toBe(cjkKeep);
    expect(await sendTag(cjkOmit)).toBeUndefined();
    expect(await sendTag(emojiKeep)).toBe(emojiKeep);
    expect(await sendTag(emojiOmit)).toBeUndefined();
  });

  it('signApnsJwt produces a 3-part ES256 token with the expected header/claims', () => {
    const runtime = createApnsRuntime(makeDeps());
    const parts = runtime.signApnsJwt(APNS_CONFIG).split('.');
    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[0], 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss).toBe('TEAM123');
  });

  it('does not register tokens with the push relay in direct mode', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: () => {
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    await expect(runtime.reRegisterAllTokens()).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('apns runtime push relay derivation and re-register', () => {
  const registerUrls = (fetchMock) =>
    fetchMock.mock.calls.filter(isRegister).map(([url]) => url);
  const sendUrls = (fetchMock) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/push/send')).map(([url]) => url);

  it('prefers OPENCHAMBER_PUSH_RELAY_URL over derived relay URLs', async () => {
    process.env.OPENCHAMBER_RELAY_URL = 'wss://env.example/ws';
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://explicit.test/v1/push/send';
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    let settings = { privateRelay: { enabled: true, relayUrl: 'wss://settings.example/ws' } };
    const runtime = createApnsRuntime(makeDeps({
      readSettingsFromDiskMigrated: async () => settings,
      writeSettingsToDisk: async (next) => { settings = next; },
      resolveEffectiveRelayUrl: async () => resolveEffectiveRelayUrl({ settings }),
    }));
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    expect(registerUrls(fetchMock)).toEqual(['https://explicit.test/v1/push/register-token']);
  });

  it('derives the push send URL from settings then env relay URLs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    let settings = { privateRelay: { enabled: true, relayUrl: 'wss://settings.example/custom' } };
    const runtime = createApnsRuntime(makeDeps({
      readSettingsFromDiskMigrated: async () => settings,
      writeSettingsToDisk: async (next) => { settings = next; },
      resolveEffectiveRelayUrl: async () => resolveEffectiveRelayUrl({ settings }),
    }));

    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    expect(registerUrls(fetchMock)).toEqual(['https://settings.example/v1/push/register-token']);

    fetchMock.mockClear();
    process.env.OPENCHAMBER_RELAY_URL = 'wss://env.example/ws';
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    expect(registerUrls(fetchMock)).toEqual(['https://env.example/v1/push/register-token']);
  });

  it('defaults to the hosted relay push endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    expect(registerUrls(fetchMock)).toEqual(['https://relay.openchamber.dev/v1/push/register-token']);
  });

  it('re-registers persisted tokens against the current relay', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-a.test/v1/push/send';
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenB');
    await runtime.addOrUpdateApnsToken('s3', 'tokenA');

    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-b.test/v1/push/send';
    fetchMock.mockClear();
    await expect(runtime.reRegisterAllTokens()).resolves.toEqual({
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(registerUrls(fetchMock).every((url) => url === 'https://relay-b.test/v1/push/register-token')).toBe(true);
    expect(registerUrls(fetchMock)).toHaveLength(2);
    expect(sendUrls(fetchMock)).toEqual([]);
  });

  it('registers with the new relay before the first send after a switch', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-a.test/v1/push/send';
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');

    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-b.test/v1/push/send';
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://relay-b.test/v1/push/register-token',
      'https://relay-b.test/v1/push/send',
    ]);
  });

  it('sends only tokens that registered successfully after a partial failure', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-a.test/v1/push/send';
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith('/register-token')) {
        const body = JSON.parse(init.body);
        if (body.token === 'tokenB') return jsonResponse({ error: true }, 500);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenB');

    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay-b.test/v1/push/send';
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const registerBodies = fetchMock.mock.calls
      .filter(isRegister)
      .map(([, init]) => JSON.parse(init.body).token)
      .sort();
    expect(registerBodies).toEqual(['tokenA', 'tokenB']);
    expect(sendUrls(fetchMock)).toEqual(['https://relay-b.test/v1/push/send']);
    expect(JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/push/send'))[1].body).tokens).toEqual(['tokenA']);

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    const retryRegister = fetchMock.mock.calls.filter(isRegister).map(([, init]) => JSON.parse(init.body).token);
    expect(retryRegister).toEqual(['tokenB']);
    expect(JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/push/send'))[1].body).tokens).toEqual(['tokenA']);
  });

  it('warns without leaking the URL when the resolver returns a non-WebSocket URL, then falls back to default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaked = 'https://evil.example/v1/push/send?token=secret';
    const runtime = createApnsRuntime(makeDeps({
      resolveEffectiveRelayUrl: async () => leaked,
    }));

    try {
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      expect(registerUrls(fetchMock)).toEqual(['https://relay.openchamber.dev/v1/push/register-token']);
      expect(warn).toHaveBeenCalled();
      const messages = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(messages).toContain('falling back to default');
      expect(messages).not.toContain(leaked);
      expect(messages).not.toContain('evil.example');
      expect(messages).not.toContain('secret');
      expect(messages).not.toContain('token=');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns without leaking the error when the resolver throws, then falls back to default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaked = 'wss://evil.example/ws?token=secret';
    const runtime = createApnsRuntime(makeDeps({
      resolveEffectiveRelayUrl: async () => {
        throw new Error(leaked);
      },
    }));

    try {
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      expect(registerUrls(fetchMock)).toEqual(['https://relay.openchamber.dev/v1/push/register-token']);
      expect(warn).toHaveBeenCalled();
      const messages = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(messages).toContain('falling back to default');
      expect(messages).not.toContain(leaked);
      expect(messages).not.toContain('evil.example');
      expect(messages).not.toContain('secret');
      expect(messages).not.toContain('token=');
    } finally {
      warn.mockRestore();
    }
  });

  it('sends more than 100 tokens in batches of at most 100, each token exactly once', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const fetchMock = vi.fn(async (url) =>
      String(url).endsWith('/register-token')
        ? jsonResponse({ ok: true })
        : jsonResponse({ results: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    const tokens = Array.from({ length: 101 }, (_, i) => `token${String(i).padStart(3, '0')}`);
    for (const [i, token] of tokens.entries()) {
      await runtime.addOrUpdateApnsToken(`s${i}`, token);
    }

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/push/send'));
    expect(sendCalls).toHaveLength(2);
    const batches = sendCalls.map(([, init]) => JSON.parse(init.body).tokens);
    expect(batches.every((batch) => Array.isArray(batch) && batch.length > 0 && batch.length <= 100)).toBe(true);
    const sent = batches.flat();
    expect(sent).toHaveLength(101);
    expect(new Set(sent).size).toBe(101);
    expect(new Set(sent)).toEqual(new Set(tokens));
    for (const [, init] of sendCalls) {
      const sentBody = JSON.parse(init.body);
      const sendMessage = `${sentBody.ts}.${[...sentBody.tokens].sort().join(',')}.${sentBody.title}`;
      expect(await verifyRelaySignature(sentBody.publicKeyJwk, sendMessage, sentBody.sig)).toBe(true);
    }
  });

  it('continues remaining send batches when one batch fails', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    let sendCount = 0;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/register-token')) return jsonResponse({ ok: true });
      sendCount += 1;
      if (sendCount === 1) return jsonResponse({ error: true }, 500);
      return jsonResponse({ results: [{ token: 'token100', ok: false, drop: true }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createApnsRuntime(makeDeps());
    const tokens = Array.from({ length: 101 }, (_, i) => `token${String(i).padStart(3, '0')}`);
    for (const [i, token] of tokens.entries()) {
      await runtime.addOrUpdateApnsToken(`s${i}`, token);
    }

    try {
      fetchMock.mockClear();
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/push/send'));
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map(([, init]) => JSON.parse(init.body).tokens).flat()).toHaveLength(101);

      fetchMock.mockClear();
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      const retryTokens = fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/v1/push/send'))
        .flatMap(([, init]) => JSON.parse(init.body).tokens);
      expect(retryTokens).not.toContain('token100');
      expect(retryTokens).toHaveLength(100);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends localized scenario titles grouped by stored token locale', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenEn', undefined, 'ios', 'en');
    await runtime.addOrUpdateApnsToken('s2', 'tokenZh', undefined, 'ios', 'zh-CN');
    await runtime.addOrUpdateApnsToken('s3', 'tokenJa', undefined, 'android', 'ja');

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({
      type: 'ready',
      sessionName: 'My session',
      badge: 2,
      tag: 'ready-x',
      data: { sessionId: 'sess1' },
    });

    const sendBodies = fetchMock.mock.calls
      .filter(isSend)
      .map(([, init]) => JSON.parse(init.body));
    expect(sendBodies).toHaveLength(3);

    const byTitle = Object.fromEntries(sendBodies.map((body) => [body.title, body]));
    expect(byTitle['Agent response is ready']?.tokens).toEqual(['tokenEn']);
    expect(byTitle['智能体回复已就绪']?.tokens).toEqual(['tokenZh']);
    expect(byTitle['エージェントの応答が準備できました']?.tokens).toEqual(['tokenJa']);
    for (const body of sendBodies) {
      expect(body.body).toBe('My session');
      expect(body.badge).toBe(2);
      const sendMessage = `${body.ts}.${[...body.tokens].sort().join(',')}.${body.title}`;
      expect(await verifyRelaySignature(body.publicKeyJwk, sendMessage, body.sig)).toBe(true);
    }
  });

  it('defaults missing token locale to English titles', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenLegacy');

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ type: 'permission', sessionName: 'S' });

    const sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
    expect(sent.title).toBe('Agent needs permission');
    expect(sent.body).toBe('S');
  });
});

const isLiveActivityRegister = ([url]) => String(url).endsWith('/register-live-activity-token');
const isLiveActivityUnregister = ([url]) => String(url).endsWith('/unregister-live-activity-token');
const isLiveActivitySend = ([url]) => String(url).endsWith('/live-activity');

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
      post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
      delete(routePath, handler) { routes.set(`DELETE ${routePath}`, handler); },
    },
    getRoute(method, routePath) { return routes.get(`${method} ${routePath}`); },
  };
};

const createMockRes = () => {
  let statusCode = 200;
  let body;
  return {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
};

const leakedWarnText = (warn) => warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

describe('apns live activity token store', () => {
  it('migrates v1 alert-token files without dropping existing device tokens', async () => {
    const fsPromises = createMemoryFs();
    await fsPromises.writeFile('/tmp/apns-tokens.json', JSON.stringify({
      version: 1,
      tokensBySession: {
        s1: [{ deviceToken: 'alert-token', createdAt: 1, lastSeenAt: 1, platform: 'ios' }],
      },
    }));
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps({ fsPromises }));

    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token', 'act-1', 'ses_1');
    const store = JSON.parse(await fsPromises.readFile('/tmp/apns-tokens.json'));
    expect(store.version).toBe(2);
    expect(store.tokensBySession.s1[0].deviceToken).toBe('alert-token');
    expect(store.liveActivityTokensBySession.s1).toEqual([
      expect.objectContaining({ token: 'la-token', activityId: 'act-1', sessionId: 'ses_1' }),
    ]);

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['alert-token']);
  });

  it('registers idempotently and replaces the token for the same activity', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);

    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token-a', 'act-1', 'ses_1');
    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token-a', 'act-1', 'ses_1');
    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token-b', 'act-1', 'ses_1');

    const store = JSON.parse(await deps.fsPromises.readFile('/tmp/apns-tokens.json'));
    expect(store.liveActivityTokensBySession.s1).toHaveLength(1);
    expect(store.liveActivityTokensBySession.s1[0].token).toBe('la-token-b');

    const unregisterCalls = fetchMock.mock.calls.filter(isLiveActivityUnregister);
    expect(unregisterCalls).toHaveLength(1);
    const unreg = JSON.parse(unregisterCalls[0][1].body);
    expect(unreg.token).toBe('la-token-a');
    expect(unreg.platform).toBe('ios');
    expect(unreg.kind).toBe('liveactivity');
    expect(await verifyRelaySignature(
      unreg.publicKeyJwk,
      `${unreg.ts}.${unreg.token}.${unreg.platform}.${unreg.kind}`,
      unreg.sig,
    )).toBe(true);

    fetchMock.mockClear();
    await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'complete' });
    const sent = JSON.parse(fetchMock.mock.calls.find(isLiveActivitySend)[1].body);
    expect(sent.tokens).toEqual(['la-token-b']);
  });

  it('refuses to unregister a token owned by a different UI session', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateLiveActivityToken('owner', 'la-token', 'act-1', 'ses_1');

    fetchMock.mockClear();
    await runtime.removeLiveActivityToken('other', 'la-token');
    expect(fetchMock.mock.calls.filter(isLiveActivityUnregister)).toHaveLength(0);

    await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'complete' });
    expect(JSON.parse(fetchMock.mock.calls.find(isLiveActivitySend)[1].body).tokens).toEqual(['la-token']);
  });

  it('caps live activity tokens per UI session and lazily expires stale entries', async () => {
    const fsPromises = createMemoryFs();
    const now = Date.now();
    await fsPromises.writeFile('/tmp/apns-tokens.json', JSON.stringify({
      version: 2,
      tokensBySession: {},
      liveActivityTokensBySession: {
        s1: [{
          token: 'expired-token',
          activityId: 'act-old',
          sessionId: 'ses_old',
          createdAt: now - 48 * 60 * 60 * 1000,
          lastSeenAt: now - 48 * 60 * 60 * 1000,
        }],
      },
      liveActivityEventVersions: {},
    }));
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps({ fsPromises }));

    for (let i = 0; i < 9; i += 1) {
      await runtime.addOrUpdateLiveActivityToken('s1', `la-token-${i}`, `act-${i}`, `ses_${i}`);
    }
    const store = JSON.parse(await fsPromises.readFile('/tmp/apns-tokens.json'));
    expect(store.liveActivityTokensBySession.s1).toHaveLength(8);
    expect(store.liveActivityTokensBySession.s1.some((entry) => entry.token === 'expired-token')).toBe(false);
    expect(store.liveActivityTokensBySession.s1.some((entry) => entry.token === 'la-token-0')).toBe(false);
    expect(store.liveActivityTokensBySession.s1[0].token).toBe('la-token-8');
  });
});

describe('apns live activity routes', () => {
  const register = (overrides = {}) => {
    const { app, getRoute } = createRouteRegistry();
    const addOrUpdateLiveActivityToken = vi.fn(async () => {});
    const removeLiveActivityToken = vi.fn(async () => {});
    registerNotificationRoutes(app, {
      getUiSessionTokenFromRequest: () => 'ui-token',
      addOrUpdateLiveActivityToken,
      removeLiveActivityToken,
      ...overrides,
    });
    return { getRoute, addOrUpdateLiveActivityToken, removeLiveActivityToken };
  };

  it('rejects missing UI auth with the apns-token error shape', async () => {
    const { getRoute, addOrUpdateLiveActivityToken, removeLiveActivityToken } = register({
      getUiSessionTokenFromRequest: () => null,
    });
    const postRes = createMockRes();
    await getRoute('POST', '/api/push/live-activity-token')({ body: { token: 't', activityId: 'a', sessionId: 's' } }, postRes);
    expect(postRes.statusCode).toBe(401);
    expect(postRes.body).toEqual({ error: 'UI session missing' });
    const delRes = createMockRes();
    await getRoute('DELETE', '/api/push/live-activity-token')({ body: { token: 't' } }, delRes);
    expect(delRes.statusCode).toBe(401);
    expect(delRes.body).toEqual({ error: 'UI session missing' });
    expect(addOrUpdateLiveActivityToken).not.toHaveBeenCalled();
    expect(removeLiveActivityToken).not.toHaveBeenCalled();
  });

  it('rejects overlong or incomplete bodies', async () => {
    const { getRoute, addOrUpdateLiveActivityToken, removeLiveActivityToken } = register();
    const postRes = createMockRes();
    await getRoute('POST', '/api/push/live-activity-token')({ body: { token: 't', activityId: 'a' } }, postRes);
    expect(postRes.statusCode).toBe(400);
    expect(postRes.body).toEqual({ error: 'Invalid body' });

    const longRes = createMockRes();
    await getRoute('POST', '/api/push/live-activity-token')({
      body: { token: 't'.repeat(513), activityId: 'act', sessionId: 'ses' },
    }, longRes);
    expect(longRes.statusCode).toBe(400);

    const delRes = createMockRes();
    await getRoute('DELETE', '/api/push/live-activity-token')({ body: {} }, delRes);
    expect(delRes.statusCode).toBe(400);
    expect(addOrUpdateLiveActivityToken).not.toHaveBeenCalled();
    expect(removeLiveActivityToken).not.toHaveBeenCalled();
  });

  it('registers and unregisters through the owning UI session', async () => {
    const { getRoute, addOrUpdateLiveActivityToken, removeLiveActivityToken } = register();
    const postRes = createMockRes();
    await getRoute('POST', '/api/push/live-activity-token')({
      body: { token: ' la-token ', activityId: ' act-1 ', sessionId: ' ses_1 ' },
    }, postRes);
    expect(postRes.body).toEqual({ ok: true });
    expect(addOrUpdateLiveActivityToken).toHaveBeenCalledWith('ui-token', 'la-token', 'act-1', 'ses_1');

    const delRes = createMockRes();
    await getRoute('DELETE', '/api/push/live-activity-token')({ body: { token: 'la-token' } }, delRes);
    expect(delRes.body).toEqual({ ok: true });
    expect(removeLiveActivityToken).toHaveBeenCalledWith('ui-token', 'la-token');
  });
});

describe('apns live activity relay and direct delivery', () => {
  it('sends a signed end payload without sessionId or user content, then drops local tokens', async () => {
    const fetchMock = vi.fn(async (url) =>
      String(url).endsWith('/register-live-activity-token') || String(url).endsWith('/live-activity')
        ? jsonResponse({ ok: true, results: [] })
        : jsonResponse({ ok: true, results: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createApnsRuntime(makeDeps());
    const sessionId = 'ses_secret_session';
    const token = 'secret-la-token-xyz';
    try {
      await runtime.addOrUpdateLiveActivityToken('s1', token, 'act-1', sessionId);
      await runtime.addOrUpdateApnsToken('s1', 'alert-token');

      fetchMock.mockClear();
      const before = Date.now();
      await runtime.sendLiveActivityEnd({ sessionId, status: 'complete' });
      const after = Date.now();

      expect(fetchMock.mock.calls.filter(isSend)).toHaveLength(0);
      const sendCall = fetchMock.mock.calls.find(isLiveActivitySend);
      expect(sendCall[0]).toBe('https://relay.test/v1/push/live-activity');
      const sent = JSON.parse(sendCall[1].body);
      expect(sent.tokens).toEqual([token]);
      expect(sent.event).toBe('end');
      expect(Object.keys(sent.contentState).sort()).toEqual(['endedAt', 'eventVersion', 'status', 'updatedAt']);
      expect(sent.contentState.status).toBe('complete');
      expect(sent.contentState.eventVersion).toBeGreaterThanOrEqual(Math.floor(before));
      expect(sent.contentState.eventVersion).toBeLessThanOrEqual(after);
      expect(sent.dismissalDate).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 15 * 60);
      expect(sent.dismissalDate).toBeLessThanOrEqual(Math.floor(after / 1000) + 15 * 60);
      expect(sent.staleDate).toBeUndefined();
      expect(sent).not.toHaveProperty('title');
      expect(sent).not.toHaveProperty('body');
      expect(sent).not.toHaveProperty('data');
      expect(JSON.stringify(sent)).not.toContain(sessionId);
      expect(JSON.stringify(sent)).not.toContain('alert');
      expect(await verifyRelaySignature(
        sent.publicKeyJwk,
        `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.event}.${sent.contentState.status}.${sent.contentState.eventVersion}.${sent.contentState.updatedAt}.${sent.contentState.endedAt ?? ''}.${sent.dismissalDate ?? ''}.${sent.staleDate ?? ''}`,
        sent.sig,
      )).toBe(true);

      expect(leakedWarnText(warn)).not.toContain(token);
      expect(leakedWarnText(warn)).not.toContain(sessionId);

      fetchMock.mockClear();
      await runtime.sendLiveActivityEnd({ sessionId, status: 'complete' });
      expect(fetchMock.mock.calls.filter(isLiveActivitySend)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('uses a 60-minute dismissal for error ends', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token', 'act-1', 'ses_1');
    const before = Date.now();
    await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'error' });
    const after = Date.now();
    const sent = JSON.parse(fetchMock.mock.calls.find(isLiveActivitySend)[1].body);
    expect(sent.contentState.status).toBe('error');
    expect(sent.dismissalDate).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 60 * 60);
    expect(sent.dismissalDate).toBeLessThanOrEqual(Math.floor(after / 1000) + 60 * 60);
  });

  it('forwards OPENCHAMBER_APNS_ENVIRONMENT=production as env on live-activity relay send', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    process.env.OPENCHAMBER_APNS_ENVIRONMENT = 'production';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token', 'act-1', 'ses_1');
    fetchMock.mockClear();
    await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'complete' });
    const sent = JSON.parse(fetchMock.mock.calls.find(isLiveActivitySend)[1].body);
    expect(sent.env).toBe('production');
  });

  it('keeps tokens after a failed relay end so a later attempt can retry', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/live-activity')) return jsonResponse({ error: true }, 500);
      return jsonResponse({ ok: true, results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createApnsRuntime(makeDeps());
    try {
      await runtime.addOrUpdateLiveActivityToken('s1', 'la-token', 'act-1', 'ses_1');
      await runtime.addOrUpdateApnsToken('s1', 'alert-token');
      fetchMock.mockClear();
      await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'complete' });
      expect(fetchMock.mock.calls.filter(isLiveActivitySend)).toHaveLength(1);

      fetchMock.mockClear();
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['alert-token']);

      fetchMock.mockImplementation(async () => jsonResponse({ ok: true, results: [] }));
      fetchMock.mockClear();
      await runtime.sendLiveActivityEnd({ sessionId: 'ses_1', status: 'complete' });
      expect(JSON.parse(fetchMock.mock.calls.find(isLiveActivitySend)[1].body).tokens).toEqual(['la-token']);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends direct live-activity headers without mixing alert tokens', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const captured = [];
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: (body) => {
              captured.push({ headers, body });
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateLiveActivityToken('s1', 'la-token', 'act-1', 'ses_secret');
    await runtime.addOrUpdateApnsToken('s1', 'alert-token');

    captured.length = 0;
    await runtime.sendLiveActivityEnd({ sessionId: 'ses_secret', status: 'complete' });
    expect(captured).toHaveLength(1);
    expect(captured[0].headers[':path']).toBe('/3/device/la-token');
    expect(captured[0].headers['apns-topic']).toBe('com.openchamber.app.push-type.liveactivity');
    expect(captured[0].headers['apns-push-type']).toBe('liveactivity');
    expect(captured[0].headers.authorization).toMatch(/^bearer /);
    const body = JSON.parse(captured[0].body);
    expect(body.aps.event).toBe('end');
    expect(body.aps.alert).toBeUndefined();
    expect(body.aps['content-state'].status).toBe('complete');
    expect(JSON.stringify(body)).not.toContain('ses_secret');
    expect(JSON.stringify(body)).not.toContain('alert-token');

    captured.length = 0;
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(captured).toHaveLength(1);
    expect(captured[0].headers[':path']).toBe('/3/device/alert-token');
    expect(captured[0].headers['apns-push-type']).toBe('alert');
    expect(captured[0].headers['apns-topic']).toBe('com.openchamber.app');
  });
});

describe('apns live activity host-relay compatibility', () => {
  const LIVE_ACTIVITY_BUNDLE_ID = 'com.yee94.openchamber';
  let pushServer;

  afterEach(async () => {
    await pushServer?.stop();
    pushServer = undefined;
  });

  it('registers through an injected-provider push relay, ends with liveactivity topic, and clears the token', async () => {
    const sessionId = 'ses_secret_session_id';
    const token = crypto.createHash('sha256').update('host-relay-live-activity-e2e').digest('hex');
    const apnsCalls = [];
    const sent = [];
    const http2 = {
      connect() {
        return {
          closed: false,
          on() { return this; },
          close() { this.closed = true; },
          request(headers) {
            const listeners = {};
            const req = {
              on(event, cb) { listeners[event] = cb; return req; },
              close() {},
              end(body) {
                apnsCalls.push({ headers, body });
                queueMicrotask(() => {
                  listeners.response?.({ ':status': '200' });
                  listeners.end?.();
                });
              },
            };
            return req;
          },
        };
      },
    };
    const innerProvider = createApnsProvider({
      keyId: 'KEYID12345',
      teamId: 'TEAMID1234',
      p8: P8,
      bundleId: LIVE_ACTIVITY_BUNDLE_ID,
      http2,
    });
    const apnsProvider = {
      async send(input) {
        sent.push(input);
        return innerProvider.send(input);
      },
      close() { innerProvider.close(); },
    };
    pushServer = createPushRelayServer({
      host: '127.0.0.1',
      port: 0,
      databasePath: ':memory:',
      apnsProvider,
    });
    await pushServer.start();
    const relayUrl = `${pushServer.url}/v1/push/send`;
    process.env.OPENCHAMBER_PUSH_RELAY_URL = relayUrl;
    delete process.env.OPENCHAMBER_PUSH_RELAY_DISABLED;
    delete process.env.OPENCHAMBER_APNS_KEY_ID;
    delete process.env.OPENCHAMBER_APNS_TEAM_ID;
    delete process.env.OPENCHAMBER_APNS_P8;
    process.env.OPENCHAMBER_APNS_BUNDLE_ID = LIVE_ACTIVITY_BUNDLE_ID;

    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);
    await runtime.addOrUpdateLiveActivityToken('s1', token, 'act-1', sessionId);
    expect(pushServer.getSnapshot()).toMatchObject({
      state: 'running',
      tokenCount: 1,
      reasons: expect.objectContaining({ authRejected: 0, policyRejected: 0 }),
    });

    await runtime.sendLiveActivityEnd({ sessionId, status: 'complete' });

    expect(sent).toHaveLength(1);
    expect(sent[0].pushType).toBe('liveactivity');
    expect(sent[0].token).toBe(token);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].headers['apns-topic']).toBe(`${LIVE_ACTIVITY_BUNDLE_ID}.push-type.liveactivity`);
    expect(apnsCalls[0].headers['apns-push-type']).toBe('liveactivity');
    const payload = JSON.parse(apnsCalls[0].body);
    expect(payload.aps.event).toBe('end');
    expect(payload.aps.alert).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(sessionId);
    expect(JSON.stringify(sent[0].payload)).not.toContain(sessionId);
    expect(pushServer.getSnapshot().tokenCount).toBe(0);
    const store = JSON.parse(await deps.fsPromises.readFile('/tmp/apns-tokens.json'));
    expect(store.liveActivityTokensBySession.s1).toBeUndefined();

    sent.length = 0;
    apnsCalls.length = 0;
    await runtime.sendLiveActivityEnd({ sessionId, status: 'complete' });
    expect(sent).toHaveLength(0);
    expect(apnsCalls).toHaveLength(0);
  });
});
