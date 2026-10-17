import { describe, expect, it } from 'vitest';
import { fetchMagpieQuotas, magpieBaseURL, projectMagpieQuotas } from './magpie.js';

const info = { name: 'magpie', version: '1', apis: ['/v1/magpie/quotas'] };
const report = { object: 'list', data: [
  { provider: 'claude', name: 'Claude', kind: 'subscription', user: 'account-a', windows: [{ name: '5h', used: 20, remaining: 80, resetsAt: '2026-10-18T12:00:00Z' }] },
  { provider: 'claude', name: 'Claude', kind: 'subscription', user: 'account-b', windows: [{ name: '5h', used: 75, remaining: 25 }] },
  { provider: 'custom', name: 'Custom', kind: 'balance', balance: '$12.34', windows: [] },
] };
const source = { id: 'instance', name: 'Gateway' };

describe('Magpie discovery and quota adapter', () => {
  it('preserves proxy prefixes and rejects credential-bearing URLs', () => {
    expect(magpieBaseURL('http://gateway.test:9876')).toBe('http://gateway.test:9876/v1');
    expect(magpieBaseURL('https://gateway.example/proxy/v1/')).toBe('https://gateway.example/proxy/v1');
    expect(magpieBaseURL('https://gateway.example/proxy')).toBe('https://gateway.example/proxy/v1');
    for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com?token=secret']) expect(() => magpieBaseURL(url)).toThrow();
  });

  it('keeps independent providers, accounts, every reset, balances and unknown periods', () => {
    const results = projectMagpieQuotas(report, source, Date.parse('2026-10-18T11:00:00Z'));
    expect(results).toHaveLength(2);
    expect(results[0].providerId).toBe('magpie:instance:claude');
    expect(results[0].usage.accounts).toHaveLength(2);
    const windows = Object.values(results[0].usage.windows);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ usedPercent: 20, remainingPercent: 80, resetAfterSeconds: 3600, resetAt: Date.parse('2026-10-18T12:00:00Z'), windowSeconds: null, disablePace: true });
    expect(Object.values(results[1].usage.windows)[0]).toMatchObject({ valueLabel: '$12.34', usedPercent: null });
  });

  it('isolates account errors and distinguishes unlimited, stale and malformed data', () => {
    const data = structuredClone(report);
    data.data[1].error = 'sensitive upstream response';
    data.data[1].asOf = '2026-10-17T11:00:00Z';
    data.data[0].windows[0].unlimited = true;
    const results = projectMagpieQuotas(data, source);
    expect(results[0].ok).toBe(false);
    expect(results[0].usage.accounts[1].stale).toBe(true);
    expect(Object.values(results[0].usage.windows)[0]).toMatchObject({ valueLabel: '∞', usedPercent: null });
    expect(JSON.stringify(results)).not.toContain('sensitive');
    expect(() => projectMagpieQuotas({ data: null }, source)).toThrow();
    expect(projectMagpieQuotas({ object: 'list', data: [] }, source)).toEqual([]);
  });

  it('identifies renamed providers by protocol, deduplicates a gateway, and keeps credential scopes separate', async () => {
    const calls = [];
    const result = await fetchMagpieQuotas({
      refresh: true,
      loadProviders: async () => ({ renamed: { settings: { baseURL: 'http://gateway.test:9876/prefix/v1' } },
        duplicate: { settings: { baseURL: 'http://gateway.test:9876/prefix/v1/' } },
        restricted: { settings: { baseURL: 'http://gateway.test:9876/prefix/v1' } },
        other: { settings: { baseURL: 'http://ordinary.test/v1' } } }),
      loadCredentials: async () => ({ renamed: { type: 'api', key: 'scope-one' }, duplicate: { type: 'api', key: 'scope-one' }, restricted: { type: 'api', key: 'scope-two' } }),
      fetchImpl: async (url, options) => {
        calls.push({ url, auth: options.headers.Authorization, redirect: options.redirect });
        return Response.json(url.includes('ordinary') ? { name: 'other' } : url.endsWith('/quotas') ? report : info);
      },
    });
    expect(calls.filter((c) => c.url.endsWith('/quotas'))).toHaveLength(2);
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);
    expect(result.sources.flatMap((s) => s.results)).toHaveLength(4);
    expect(new Set(result.sources.flatMap((s) => s.results.map((r) => r.providerId))).size).toBe(4);
    expect(JSON.stringify(result)).not.toContain('scope-one');
  });

  it('does not turn denied access or unavailable gateways into empty success', async () => {
    const result = await fetchMagpieQuotas({
      refresh: true,
      loadProviders: async () => ({ magpie: { settings: { baseURL: 'http://gateway.test/v1' } } }),
      loadCredentials: async () => ({}),
      fetchImpl: async (url) => url.endsWith('/quotas') ? new Response('secret', { status: 403 }) : Response.json(info),
    });
    expect(result.sources[0]).toMatchObject({ identified: true, error: 'Magpie quota access denied (check gateway key permissions)' });
    await expect(fetchMagpieQuotas({ loadProviders: async () => { throw new Error('offline'); }, loadCredentials: async () => ({}) })).rejects.toThrow();
  });

  it('bounds discovery concurrency and avoids quota fanout with 100 accounts', async () => {
    let active = 0; let peak = 0; let requests = 0;
    const providers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, { settings: { baseURL: `http://gateway-${i}.test/v1` } }]));
    await fetchMagpieQuotas({ refresh: true, loadProviders: async () => providers, loadCredentials: async () => ({}), fetchImpl: async (url) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (url.endsWith('/quotas')) requests++;
      return Response.json(url.endsWith('/quotas') ? { object: 'list', data: Array.from({ length: 100 }, (_, i) => ({ ...report.data[0], user: `account-${i}` })) } : info);
    } });
    expect(peak).toBeLessThanOrEqual(4);
    expect(requests).toBe(12);
  });

  it('uses kept snapshots on opening and labels fallback readings after failed refresh', async () => {
    const calls = [];
    const options = { manualURL: 'http://gateway.test/proxy', loadProviders: async () => ({}), loadCredentials: async () => ({}),
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/quotas')) throw new Error('timeout');
        return Response.json(url.endsWith('?kept=1') ? report : info);
      } };
    const snapshot = await fetchMagpieQuotas(options);
    expect(snapshot.sources[0].results).toHaveLength(2);
    expect(calls).toEqual(['http://gateway.test/proxy/v1', 'http://gateway.test/proxy/v1/magpie/quotas?kept=1']);
    const refreshed = await fetchMagpieQuotas({ ...options, refresh: true });
    expect(refreshed.sources[0].error).toContain('last reading');
    expect(refreshed.sources[0].results[0].usage.accounts.every((a) => a.stale)).toBe(true);
  });
});
