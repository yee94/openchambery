import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('encoding-polyfill', () => {
  beforeEach(() => {
    vi.resetModules();
    const g = globalThis as typeof globalThis & {
      TextEncoder?: unknown;
      TextDecoder?: unknown;
    };
    // Force reinstall path — cast through unknown for delete under DOM lib types.
    Reflect.deleteProperty(g, 'TextEncoder');
    Reflect.deleteProperty(g, 'TextDecoder');
  });

  test('installs TextEncoder/TextDecoder when missing', async () => {
    await import('./encoding-polyfill');
    expect(typeof TextEncoder).toBe('function');
    expect(typeof TextDecoder).toBe('function');
    const encoded = new TextEncoder().encode('Connecting…');
    expect(encoded.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(encoded)).toBe('Connecting…');
  });
});
