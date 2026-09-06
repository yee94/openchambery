import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDirectoryQueryCanonicalizer,
  isInteractiveSessionRequest,
  normalizeForwardedDirectoryHeaders,
  registerOpenCodeProxy,
  resolveSessionTurnAdmissionRequest,
} from './proxy.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const readyRuntime = () => ({
  isOpenCodeReady: true,
  openCodeNotReadySince: 0,
  isRestartingOpenCode: false,
  openCodePort: 4096,
  openCodeBaseUrl: 'http://127.0.0.1:4096',
});

const mountProxy = () => {
  const app = express();
  // Fresh app each time — registerOpenCodeProxy guards on app setting.
  registerOpenCodeProxy(app, {
    fs: { promises: { realpath: async (v) => v } },
    os: {},
    path: {},
    OPEN_CODE_READY_GRACE_MS: 1000,
    LONG_REQUEST_TIMEOUT_MS: 60_000,
    SSE_UPSTREAM_CONNECT_TIMEOUT_MS: 5_000,
    SSE_UPSTREAM_STALL_TIMEOUT_MS: 5_000,
    getRuntime: readyRuntime,
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  return app;
};

const sseBody = (blocks) => {
  const encoder = new TextEncoder();
  const text = blocks.join('');
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: encoder.encode(text) };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
    async cancel() {},
  };
};

describe('createDirectoryQueryCanonicalizer', () => {
  it('canonicalizes directory query params and preserves other params', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async (value) => value === '/link/project' ? '/real/project' : value,
    });

    await expect(canonicalize('/session?foo=1&directory=/link/project&bar=2'))
      .resolves.toBe('/session?foo=1&directory=%2Freal%2Fproject&bar=2');
  });

  it('caches directory realpath lookups', async () => {
    let calls = 0;
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return '/real/project';
      },
    });

    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    await expect(canonicalize('/session?directory=/link/project')).resolves.toBe('/session?directory=%2Freal%2Fproject');
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent directory realpath lookups', async () => {
    let calls = 0;
    let release = () => undefined;
    const pending = new Promise((resolve) => {
      release = () => resolve('/real/project');
    });
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        calls += 1;
        return pending;
      },
    });

    const first = canonicalize('/session?directory=/link/project');
    const second = canonicalize('/session?directory=/link/project');
    await Promise.resolve();

    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      '/session?directory=%2Freal%2Fproject',
      '/session?directory=%2Freal%2Fproject',
    ]);
  });

  it('falls back to the original URL when realpath fails', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => {
        throw new Error('missing');
      },
    });

    await expect(canonicalize('/session?foo=1&directory=/missing/project'))
      .resolves.toBe('/session?foo=1&directory=/missing/project');
  });

  it('leaves URLs without directory params unchanged', async () => {
    const canonicalize = createDirectoryQueryCanonicalizer({
      realpath: async () => '/real/project',
    });

    await expect(canonicalize('/session?foo=1')).resolves.toBe('/session?foo=1');
  });
});

describe('normalizeForwardedDirectoryHeaders', () => {
  it('decodes marked directory headers before forwarding to OpenCode', () => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': encodeURIComponent('/Users/example/project'),
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      'x-opencode-directory': '/Users/example/project',
    });
  });

  it('preserves unmarked percent sequences from direct clients', () => {
    const headers = normalizeForwardedDirectoryHeaders({
      'x-opencode-directory': '/Users/example/project%20literal',
    });

    expect(headers).toEqual({
      'x-opencode-directory': '/Users/example/project%20literal',
    });
  });
});

describe('isInteractiveSessionRequest', () => {
  it('prioritizes selected-session detail and message reads', () => {
    expect(isInteractiveSessionRequest('GET', '/api/session/ses_1')).toBe(true);
    expect(isInteractiveSessionRequest('GET', '/api/session/ses_1/message?limit=30')).toBe(true);
    expect(isInteractiveSessionRequest('GET', '/api/session/ses_1/children')).toBe(true);
  });

  it('prioritizes session mutations but not background session lists', () => {
    expect(isInteractiveSessionRequest('GET', '/api/session?roots=true&limit=20')).toBe(false);
    expect(isInteractiveSessionRequest('POST', '/api/session/ses_1/message')).toBe(true);
  });
});

describe('resolveSessionTurnAdmissionRequest', () => {
  it('recognizes direct client turn endpoints with a directory scope', () => {
    expect(resolveSessionTurnAdmissionRequest({ method: 'POST', originalUrl: '/api/session/ses_1/message?directory=%2Frepo', query: { directory: '/repo' } })).toEqual({ directory: '/repo', sessionID: 'ses_1' });
    expect(resolveSessionTurnAdmissionRequest({ method: 'POST', url: '/session/ses%2F2/prompt_async', headers: { 'x-opencode-directory': '%2Frepo', 'x-opencode-directory-encoding': 'uri' } })).toEqual({ directory: '/repo', sessionID: 'ses/2' });
  });

  it('ignores reads, unrelated routes, and unscoped admissions', () => {
    expect(resolveSessionTurnAdmissionRequest({ method: 'GET', url: '/api/session/ses_1/message', query: { directory: '/repo' } })).toBeNull();
    expect(resolveSessionTurnAdmissionRequest({ method: 'POST', url: '/api/session', query: { directory: '/repo' } })).toBeNull();
    expect(resolveSessionTurnAdmissionRequest({ method: 'POST', url: '/api/session/ses_1/message' })).toBeNull();
  });
});

describe('registerOpenCodeProxy reasoning projection routes', () => {
  it('strips includeReasoning from SSE upstream and drops reasoning events when false', async () => {
    const upstreamUrls = [];
    globalThis.fetch = vi.fn(async (url) => {
      upstreamUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: sseBody([
          'id: 1\ndata: {"type":"message.part.updated","properties":{"part":{"id":"t","messageID":"m","type":"text","text":"hi"}}}\n\n',
          'id: 2\ndata: {"type":"session.next.reasoning.delta.1","properties":{"delta":"secret"}}\n\n',
          'id: 3\ndata: {"type":"message.part.delta","properties":{"messageID":"m","partID":"t","field":"text","delta":"!"}}\n\n',
        ]),
      };
    });

    const app = mountProxy();
    const res = await request(app)
      .get('/api/event?directory=%2Ftmp&includeReasoning=false')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(Buffer.from(c)));
        response.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
      });

    expect(res.status).toBe(200);
    expect(upstreamUrls).toHaveLength(1);
    expect(upstreamUrls[0]).not.toContain('includeReasoning');
    expect(upstreamUrls[0]).toContain('directory=');
    expect(res.body).toContain('"type":"message.part.updated"');
    expect(res.body).toContain('"type":"message.part.delta"');
    expect(res.body).not.toContain('reasoning');
    expect(res.body).not.toContain('secret');
  });

  it('byte-passthrough SSE when includeReasoning is omitted', async () => {
    const raw =
      'id: 1\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"keep"}}\n\n';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody([raw]),
    }));

    const app = mountProxy();
    const res = await request(app)
      .get('/api/global/event')
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(Buffer.from(c)));
        response.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
      });

    expect(res.status).toBe(200);
    expect(res.body).toContain('session.next.reasoning.delta');
    expect(res.body).toContain('keep');
  });

  it('filters session.messages list JSON and strips includeReasoning upstream', async () => {
    const upstreamUrls = [];
    globalThis.fetch = vi.fn(async (url) => {
      upstreamUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async text() {
          return JSON.stringify([
            {
              info: { id: 'msg_1', tokens: { reasoning: 12 } },
              parts: [
                { id: 'r', type: 'reasoning', text: 'hidden' },
                { id: 't', type: 'text', text: 'visible' },
              ],
            },
          ]);
        },
      };
    });

    const app = mountProxy();
    const res = await request(app)
      .get('/api/session/ses_1/message?limit=30&includeReasoning=false&directory=%2Frepo');

    expect(res.status).toBe(200);
    expect(upstreamUrls[0]).not.toContain('includeReasoning');
    expect(upstreamUrls[0]).toContain('/session/ses_1/message');
    expect(res.body[0].parts).toEqual([{ id: 't', type: 'text', text: 'visible' }]);
    expect(res.body[0].info.tokens.reasoning).toBe(12);
    expect(JSON.stringify(res.body)).not.toContain('hidden');
  });

  it('keeps reasoning parts on session.messages list when includeReasoning is omitted', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async text() {
        return JSON.stringify([
          {
            info: { id: 'msg_1' },
            parts: [{ id: 'r', type: 'reasoning', text: 'keep-me' }],
          },
        ]);
      },
    }));

    const app = mountProxy();
    const res = await request(app).get('/api/session/ses_1/message');
    expect(res.status).toBe(200);
    expect(res.body[0].parts[0].type).toBe('reasoning');
    expect(res.body[0].parts[0].text).toBe('keep-me');
  });
});
