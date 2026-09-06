import { describe, expect, test } from 'vitest';

import { createLynxHttpClientAdapter } from './httpClient';

describe('Lynx host HTTP client adapter', () => {
  test('without host falls back to fetch client shape', async () => {
    const adapter = createLynxHttpClientAdapter();
    expect(adapter.isHostBound()).toBe(false);
    expect(typeof adapter.asClient().request).toBe('function');
  });

  test('host binder maps bodyText → json/text', async () => {
    const adapter = createLynxHttpClientAdapter();
    adapter.inject({
      request: async (input) => ({
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ url: input.url, method: input.method }),
      }),
    });
    expect(adapter.isHostBound()).toBe(true);
    const res = await adapter.request('https://example.test/health', { method: 'GET' });
    expect(res?.ok).toBe(true);
    expect(await res?.json()).toEqual({ url: 'https://example.test/health', method: 'GET' });
    expect(await res?.text?.()).toContain('health');
  });
});
