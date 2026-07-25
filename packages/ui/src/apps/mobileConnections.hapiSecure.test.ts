import { afterEach, describe, expect, mock, test } from 'bun:test';

// Isolated file: mock SecureStorage before any import of mobileConnections.
// Native path is triggered via window.location.protocol === 'capacitor:'
// (isCapacitorApp), not by mocking @/lib/platform (that would leak into other files).

const secureSetCalls: Array<{ prefixedKey: string; dataLength: number }> = [];
let secureSetShouldFail = false;

mock.module('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    internalSetItem: async (options: { prefixedKey: string; data: string }) => {
      // Never record the raw token in test state dumps — length only.
      secureSetCalls.push({
        prefixedKey: options.prefixedKey,
        dataLength: typeof options.data === 'string' ? options.data.length : 0,
      });
      if (secureSetShouldFail) throw new Error('keychain denied');
    },
    internalGetItem: async () => ({ data: null }),
    internalRemoveItem: async () => ({ success: true }),
  },
}));

const originalWindow = globalThis.window;

const installNativeWindow = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: 'capacitor:', href: 'capacitor://localhost/' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
  });
};

const { persistHapiAccessTokensForNative } = await import('./mobileConnections');

afterEach(() => {
  secureSetCalls.length = 0;
  secureSetShouldFail = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

const SECRET = 'cli_secret_token:ns';

const hapiRelay = {
  relayUrl: 'wss://hub.example/api/openchamber/relay/ws',
  serverId: 'srv_test',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as JsonWebKey,
  transport: 'hapi' as const,
  accessToken: SECRET,
};

describe('persistHapiAccessTokensForNative secure write', () => {
  test('throws a token-free error when secure write fails (no hasAccessToken metadata path)', async () => {
    installNativeWindow();
    secureSetShouldFail = true;

    const candidates = [{ kind: 'relay' as const, relay: hapiRelay }];
    let thrown: unknown;
    try {
      await persistHapiAccessTokensForNative(candidates);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('Failed to store HAPI access token securely');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('cli_secret_token');
    // Attempt happened; caller must not proceed to writeConnections with hasAccessToken:true.
    expect(secureSetCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('on success returns hasAccessToken; logs never include the raw token', async () => {
    installNativeWindow();
    secureSetShouldFail = false;
    const infoCalls: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      infoCalls.push(args.map(String).join(' '));
    };
    try {
      const out = await persistHapiAccessTokensForNative([
        { kind: 'relay', relay: hapiRelay },
      ]);
      const relay = out.find((c) => c.kind === 'relay');
      expect(relay && relay.kind === 'relay' ? relay.relay.hasAccessToken : null).toBe(true);
      expect(relay && relay.kind === 'relay' ? relay.relay.accessToken : null).toBe(SECRET);
      const joined = infoCalls.join('\n');
      expect(joined).not.toContain(SECRET);
      expect(joined).not.toContain('cli_secret_token');
      expect(secureSetCalls.some((c) => c.prefixedKey.includes('hapi-token'))).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });
});
