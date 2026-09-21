import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (overrides = {}) => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    ...overrides.state,
  },
  getOpenCodeAuthHeaders: () => ({}),
  configuredOpenCodeHostname: overrides.configuredOpenCodeHostname,
});

describe('OpenCode network runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('probes /api/info with Authorization and treats healthy true as ready', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(String(url)).toContain('/api/info');
      expect(options.headers.Authorization).toMatch(/^Basic /);
      return new Response(JSON.stringify({ version: '2.0.12', pid: 1, urls: [], paths: { tmp: '/tmp' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock;

    const runtime = createOpenCodeNetworkRuntime({
      state: {
        openCodePort: 4096,
        openCodeBaseUrl: null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: false,
        openCodeApiDetectionTimer: null,
      },
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic Zml4dHVyZQ==' }),
    });

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 1000)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/info');
  });

  it('falls back to /global/health when /api/info is not healthy', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/info')) {
        return new Response('not found', { status: 404 });
      }
      if (String(url).includes('/global/health')) {
        return new Response(JSON.stringify({ healthy: true, version: '2.0.12' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('no', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const runtime = createOpenCodeNetworkRuntime({
      state: {
        openCodePort: 4096,
        openCodeBaseUrl: null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: false,
        openCodeApiDetectionTimer: null,
      },
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic Zml4dHVyZQ==' }),
    });

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 1000)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/info');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/global/health');
  });

  it('returns false when readiness fetch rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const runtime = createRuntime();
    const readyPromise = runtime.waitForReady('http://127.0.0.1:4096', 1);

    await expect(readyPromise).resolves.toBe(false);
  });

  it('builds managed OpenCode URLs against IPv4 loopback by default', () => {
    const runtime = createRuntime();

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://127.0.0.1:4096/api/provider');
  });

  it('keeps external OpenCode base URLs authoritative', () => {
    const runtime = createRuntime({
      state: { openCodeBaseUrl: 'http://remote.example:4096' },
    });

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://remote.example:4096/api/provider');
  });

  it('keeps SDK base URLs (/) and already-prefixed paths untouched', () => {
    const runtime = createRuntime();

    expect(runtime.buildOpenCodeUrl('/')).toBe('http://127.0.0.1:4096/');
    expect(runtime.buildOpenCodeUrl('/api/info')).toBe('http://127.0.0.1:4096/api/info');
  });

  it('normalizes wildcard and IPv6 OpenCode bind hosts for local connects', () => {
    expect(createRuntime({ configuredOpenCodeHostname: '0.0.0.0' }).buildOpenCodeUrl('/provider'))
      .toBe('http://127.0.0.1:4096/api/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '::1' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/api/provider');
  });
});
