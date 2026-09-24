import http from 'node:http';

import { describe, expect, test } from 'vitest';

import {
  BROWSER_PROVIDER_PATH,
  extensionDeclaresBrowser,
  readBrowserProviderRequest,
} from './contract.js';
import { BrowserProviderError } from './contract.js';
import { createBrowserProviderHost } from './host.js';

const declaring = (overrides = {}) => ({
  id: 'server-chrome',
  name: 'Server Chrome',
  service: { provides: ['browser'] },
  answer: async () => ({ ok: true, data: { url: 'http://127.0.0.1/', title: 'App' } }),
  ...overrides,
});

describe('extensionDeclaresBrowser', () => {
  test('recognizes a browser declaration and ignores other roles', () => {
    expect(extensionDeclaresBrowser({ service: { provides: ['browser'] } })).toBe(true);
    expect(extensionDeclaresBrowser({ provides: ['browser'] })).toBe(true);
    expect(extensionDeclaresBrowser({ contributes: { service: { provides: ['browser'] } } })).toBe(true);
    expect(extensionDeclaresBrowser({ service: { provides: ['printer'] } })).toBe(false);
    expect(extensionDeclaresBrowser({ service: { provides: [] } })).toBe(false);
    expect(extensionDeclaresBrowser({ service: {} })).toBe(false);
    expect(extensionDeclaresBrowser(null)).toBe(false);
    expect(extensionDeclaresBrowser({ service: { provides: ['printer'] }, provides: ['browser'] })).toBe(false);
  });
});

describe('browser provider host', () => {
  test('rejects an extension that does not declare browser and does not list it', () => {
    const host = createBrowserProviderHost();
    expect(() => host.install({ id: 'other', name: 'Other', answer: async () => ({ ok: true, data: {} }) }))
      .toThrow(BrowserProviderError);
    return expect(host.list()).resolves.toEqual([]);
  });

  test('lists a reachable browser declaration and hides the transport', async () => {
    const host = createBrowserProviderHost();
    const answer = async () => ({ ok: true, data: { url: 'http://a/' } });
    expect(host.install(declaring({ answer, endpoint: 'http://example.com/steal' }))).toEqual({
      id: 'server-chrome',
      name: 'Server Chrome',
      surface: false,
    });
    const providers = await host.list();
    expect(providers).toEqual([{ id: 'server-chrome', name: 'Server Chrome', surface: false }]);
    expect(JSON.stringify(providers)).not.toContain('endpoint');
    expect(JSON.stringify(providers)).not.toContain('answer');
  });

  test('refuses a non-loopback endpoint and does not register it', async () => {
    const host = createBrowserProviderHost();
    expect(() => host.install(declaring({
      answer: undefined,
      endpoint: 'http://example.com/browser-control',
    }))).toThrow(/loopback/);
    await expect(host.list()).resolves.toEqual([]);
  });

  test('sends the agent action to the selected provider and adopts its data', async () => {
    const seen = [];
    const host = createBrowserProviderHost({ createId: () => 'req-1' });
    host.install(declaring({
      answer: async (request) => {
        seen.push(request);
        return { ok: true, data: { url: 'http://127.0.0.1/', title: 'App', clicked: '#save' } };
      },
    }));
    await host.select('server-chrome');
    const result = await host.dispatchAgentBrowserAction({
      action: 'browser.click',
      parameters: { selector: '#save', extra: 'drop-me' },
      context: { directory: '/repo', sessionId: 'ses_1' },
    });
    expect(result).toEqual({
      providerId: 'server-chrome',
      data: { url: 'http://127.0.0.1/', title: 'App', clicked: '#save' },
    });
    expect(seen).toEqual([{
      requestId: 'req-1',
      action: 'browser.click',
      parameters: { selector: '#save' },
      context: { directory: '/repo', sessionId: 'ses_1' },
    }]);
    expect(readBrowserProviderRequest(JSON.stringify(seen[0]))).toEqual(seen[0]);
  });

  test('posts to the extension loopback and adopts that result', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: { url: 'http://127.0.0.1/', title: 'Loop' } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const host = createBrowserProviderHost({ createId: () => 'req-loop' });
      host.install(declaring({
        answer: undefined,
        endpoint: `http://127.0.0.1:${port}`,
      }));
      await host.select('server-chrome');
      const result = await host.dispatchAgentBrowserAction({
        action: 'browser.open',
        parameters: { url: 'http://127.0.0.1:3000/app' },
        context: { directory: '', sessionId: 7 },
      });
      expect(result.data).toEqual({ url: 'http://127.0.0.1/', title: 'Loop' });
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe(BROWSER_PROVIDER_PATH);
      expect(seen[0].body.context).toEqual({ directory: null, sessionId: null });
      expect(seen[0].body.action).toBe('browser.open');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test('uses the extension error and does not turn it into empty data', async () => {
    const host = createBrowserProviderHost();
    host.install(declaring({
      answer: async () => ({ ok: false, error: 'No element matches #save' }),
    }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({
      action: 'browser.click',
      parameters: { selector: '#save' },
    })).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      status: 400,
      message: 'No element matches #save',
    });
  });

  test('a malformed answer is unknown page state, not success', async () => {
    const host = createBrowserProviderHost();
    host.install(declaring({ answer: async () => ({ ok: true }) }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.snapshot', parameters: {} }))
      .rejects.toMatchObject({ code: 'UNKNOWN_RESULT', status: 502 });
  });

  test('no selected provider rejects and does not call the extension', async () => {
    const seen = [];
    const host = createBrowserProviderHost();
    host.install(declaring({
      answer: async () => {
        seen.push('called');
        return { ok: true, data: {} };
      },
    }));
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.snapshot', parameters: {} }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER', status: 409 });
    expect(seen).toEqual([]);
  });

  test('an unknown selection does not change the current choice or run an action', async () => {
    const host = createBrowserProviderHost();
    host.install(declaring());
    await host.select('server-chrome');
    await expect(host.select('missing')).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND', status: 404 });
    expect(host.selectedId()).toBe('server-chrome');
    await expect(host.dispatchAgentBrowserAction({
      action: 'browser.snapshot',
      parameters: {},
      providerId: 'missing',
    })).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });

  test('a catalog read failure is not an empty provider list and does not send the action', async () => {
    const seen = [];
    const host = createBrowserProviderHost({
      readInstalled: async () => {
        throw new Error('disk');
      },
    });
    await expect(host.list()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', status: 503 });
    await expect(host.dispatchAgentBrowserAction({
      action: 'browser.snapshot',
      parameters: {},
      providerId: 'server-chrome',
    })).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
    expect(seen).toEqual([]);
  });

  test('a non-array catalog is not treated as no providers', async () => {
    const host = createBrowserProviderHost({
      readInstalled: async () => /** @type {any} */ (null),
    });
    await expect(host.list()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
  });

  test('invalid actions are not sent', async () => {
    const seen = [];
    const host = createBrowserProviderHost();
    host.install(declaring({
      answer: async () => {
        seen.push('called');
        return { ok: true, data: {} };
      },
    }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.explode', parameters: {} }))
      .rejects.toMatchObject({ code: 'INVALID_ACTION' });
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.open', parameters: { url: 'file:///tmp/x' } }))
      .rejects.toMatchObject({ code: 'INVALID_ACTION' });
    expect(seen).toEqual([]);
  });

  test('a provider that throws after receiving the action is not reported as unchanged', async () => {
    const host = createBrowserProviderHost();
    host.install(declaring({
      answer: async () => {
        throw new Error('socket dropped');
      },
    }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.snapshot', parameters: {} }))
      .rejects.toMatchObject({ code: 'REQUEST_FAILED', status: 504 });
  });

  test('a refused connection is not sent and is not success', async () => {
    const host = createBrowserProviderHost({
      fetchImpl: async () => {
        const error = new TypeError('fetch failed');
        error.cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        throw error;
      },
    });
    host.install(declaring({ answer: undefined, endpoint: 'http://127.0.0.1:9' }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.snapshot', parameters: {} }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
  });

  test('an HTTP error answer is unknown page state', async () => {
    const host = createBrowserProviderHost({
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    host.install(declaring({ answer: undefined, endpoint: 'http://127.0.0.1:9/browser-control' }));
    await host.select('server-chrome');
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.back', parameters: {} }))
      .rejects.toMatchObject({ code: 'UNKNOWN_RESULT', status: 502 });
  });

  test('a saved selection is used after restart and a failed save does not change it', async () => {
    const writes = [];
    let saved = 'server-chrome';
    const store = {
      read: async () => saved,
      write: async (id) => {
        writes.push(id);
        if (id === 'other-chrome') throw new Error('disk');
        saved = id;
      },
    };
    const restored = createBrowserProviderHost({ selectionStore: store });
    restored.install(declaring());
    await expect(restored.dispatchAgentBrowserAction({
      action: 'browser.snapshot',
      parameters: {},
    })).resolves.toMatchObject({ providerId: 'server-chrome' });

    restored.install(declaring({ id: 'other-chrome', name: 'Other Chrome' }));
    await expect(restored.select('other-chrome')).rejects.toMatchObject({ code: 'SELECTION_UNAVAILABLE' });
    expect(restored.selectedId()).toBe('server-chrome');
    expect(writes).toEqual(['other-chrome']);
    await expect(restored.catalog()).resolves.toMatchObject({ selectedId: 'server-chrome' });
  });

  test('a saved id that is not installed is not reported as the connected provider', async () => {
    const host = createBrowserProviderHost({
      selectionStore: { read: async () => 'server-chrome', write: async () => undefined },
    });
    await expect(host.catalog()).resolves.toEqual({ providers: [], selectedId: null });
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.snapshot', parameters: {} }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });

  test('a cancelled action is not sent', async () => {
    const seen = [];
    const host = createBrowserProviderHost();
    host.install(declaring({
      answer: async () => {
        seen.push('called');
        return { ok: true, data: {} };
      },
    }));
    await host.select('server-chrome');
    const signal = AbortSignal.abort();
    await expect(host.dispatchAgentBrowserAction({ action: 'browser.back', parameters: {}, signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(seen).toEqual([]);
  });
});
