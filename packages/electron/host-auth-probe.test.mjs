import { describe, expect, it, vi } from 'vitest';
import { probeHostAuthentication } from './host-auth-probe.mjs';

describe('desktop host authentication probe', () => {
  it.each([401, 403])('rejects credentials on HTTP %s', async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    expect(await probeHostAuthentication('https://remote.example', { headers: {}, timeoutMs: 1000, fetchImpl })).toBe('auth');
  });

  it('requires an authoritative authenticated response, including with HTTP 200', async () => {
    for (const payload of [{ authenticated: false }, { service: 'openchamber' }]) {
      const fetchImpl = vi.fn(async () => Response.json(payload));
      expect(await probeHostAuthentication('https://remote.example', { headers: {}, timeoutMs: 1000, fetchImpl })).toBe('auth');
    }
  });

  it('checks the protected session using the same explicit credential as runtime requests', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ authenticated: true }));
    const headers = { Authorization: 'Bearer test-client', 'X-Access': 'test-access' };
    expect(await probeHostAuthentication('https://remote.example', { headers, timeoutMs: 1000, fetchImpl })).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith('https://remote.example/auth/session', expect.objectContaining({ headers, redirect: 'error' }));
  });

  it('preserves transport failure as unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    expect(await probeHostAuthentication('https://remote.example', { headers: {}, timeoutMs: 1000, fetchImpl })).toBe('unreachable');
  });
});
