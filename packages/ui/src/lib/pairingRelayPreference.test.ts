import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PAIRING_RELAY_URL,
  normalizePairingRelayUrl,
  readPairingRelayUrlPreference,
  writePairingRelayUrlPreference,
} from './pairingRelayPreference';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
};

describe('pairing relay preference', () => {
  test('uses the official Relay as the product default', () => {
    expect(DEFAULT_PAIRING_RELAY_URL).toBe('wss://relay.openchamber.dev/ws');
  });

  test('accepts websocket endpoints and rejects non-websocket URLs', () => {
    expect(normalizePairingRelayUrl(' wss://relay.example/custom#fragment ')).toBe('wss://relay.example/custom');
    expect(normalizePairingRelayUrl('wss://relay.example/custom?token=secret#frag')).toBe('wss://relay.example/custom');
    expect(normalizePairingRelayUrl('ws://127.0.0.1:8787/ws')).toBe('ws://127.0.0.1:8787/ws');
    expect(normalizePairingRelayUrl('https://relay.example/ws')).toBeNull();
    expect(normalizePairingRelayUrl('not a url')).toBeNull();
  });

  test('rejects endpoints that embed username/password userinfo', () => {
    expect(normalizePairingRelayUrl('wss://user:pass@relay.example/ws')).toBeNull();
    expect(normalizePairingRelayUrl('ws://user@127.0.0.1:8787/ws')).toBeNull();
  });

  test('persists the last valid endpoint locally for the next pairing', () => {
    const storage = createStorage();
    writePairingRelayUrlPreference('wss://relay.example/ws?token=secret#frag', storage);
    expect(readPairingRelayUrlPreference(storage)).toBe('wss://relay.example/ws');

    writePairingRelayUrlPreference('https://invalid.example/ws', storage);
    expect(readPairingRelayUrlPreference(storage)).toBe('wss://relay.example/ws');

    writePairingRelayUrlPreference('wss://user:pass@relay.example/other', storage);
    expect(readPairingRelayUrlPreference(storage)).toBe('wss://relay.example/ws');
  });
});
