import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeUpdateDiscovery } from './update-discovery.js';

describe('OpenCode remote update discovery', () => {
  it('shares concurrent requests, caches for five minutes and refreshes after expiry', async () => {
    let time = 0;
    const fetchImpl = vi.fn(async () => Response.json({ version: '2.0.18' }));
    const discover = createOpenCodeUpdateDiscovery({ fetchImpl, now: () => time });
    expect(await Promise.all([discover(), discover(), discover()])).toEqual(['2.0.18', '2.0.18', '2.0.18']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 299_999;
    await discover();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 300_000;
    fetchImpl.mockResolvedValueOnce(Response.json({ version: '2.0.19' }));
    expect(await discover()).toBe('2.0.19');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['1.18.4', '3.0.0', '2.0.19-beta.1', 'latest', undefined])('rejects an invalid stable release %s', async (version) => {
    const discover = createOpenCodeUpdateDiscovery({ fetchImpl: async () => Response.json({ version }) });
    await expect(discover()).rejects.toThrow('stable 2.x');
  });

  it('backs off errors without reporting stale success, then recovers', async () => {
    let time = 0;
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ version: '2.0.18' }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ version: '2.0.19' }));
    const discover = createOpenCodeUpdateDiscovery({ fetchImpl, now: () => time });
    await discover();
    time = 300_000;
    await expect(discover()).rejects.toThrow('offline');
    await expect(discover()).rejects.toThrow('offline');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time += 30_000;
    expect(await discover()).toBe('2.0.19');
  });
});
