import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const ctx = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

describe('VS Code API proxy aborts', () => {
  test('aborts non-SSE api:proxy fetches by bridge request id', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;

    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/session/abc/prompt_async', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy read coalescing', () => {
  test('shares one upstream fetch across concurrent identical GET reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let release: () => void = () => {};

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const first = handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown }).headers, (b?.data as { headers: unknown }).headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not coalesce POST writes or non-allowlisted reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code exact message GET L1 projection', () => {
  test('projects summary.diffs to thin file list + diffCount/hasDiffs before webview', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        info: {
          id: 'msg_1',
          role: 'user',
          summary: {
            title: 'turn',
            diffs: [{
              file: 'src/a.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              patch: '@@ huge @@',
              before: 'old',
              after: 'new',
            }],
          },
        },
        parts: [{ id: 'prt_1', type: 'text', text: 'hello' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'exact_1',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/session/ses_1/message/msg_1?directory=/repo' },
        },
        ctx,
        deps,
      );

      assert.equal(response?.success, true);
      const bodyText = (response?.data as { bodyText?: string }).bodyText ?? '';
      const body = JSON.parse(bodyText) as {
        info: { summary: Record<string, unknown> };
        parts: unknown[];
      };
      assert.deepEqual(body.info.summary, {
        title: 'turn',
        diffs: [{
          file: 'src/a.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        }],
        diffCount: 1,
        hasDiffs: true,
      });
      assert.equal(body.parts.length, 1);
      assert.equal(bodyText.includes('@@ huge @@'), false);
      assert.equal(bodyText.includes('"before"'), false);
      assert.equal(bodyText.includes('"after"'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
