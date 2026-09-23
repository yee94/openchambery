import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import type { ConnectionStatus, OpenCodeManager } from './opencode';
import {
  ensureOpenCodeApiUpstreamPath,
  handleProxyBridgeMessage,
  isBridgeExecutionWritePath,
} from './bridge-proxy-runtime';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({
    status: 503,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({ error: 'unavailable' }),
  }),
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

const createManagerCtx = (initial: { status: ConnectionStatus; url: string | null }) => {
  let status = initial.status;
  let url = initial.url;
  const listeners = new Set<(s: ConnectionStatus) => void>();
  const manager = {
    getStatus: () => status,
    getApiUrl: () => url,
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (s: ConnectionStatus) => void) => {
      listeners.add(cb);
      cb(status);
      return { dispose: () => listeners.delete(cb) };
    },
  } as unknown as OpenCodeManager;
  const transition = (next: ConnectionStatus, nextUrl: string | null) => {
    status = next;
    url = nextUrl;
    listeners.forEach((cb) => cb(status));
  };
  return {
    ctx: { manager } as unknown as BridgeContext,
    transition,
  };
};

const ctx = createManagerCtx({ status: 'connected', url: 'http://127.0.0.1:3902' }).ctx;

describe('VS Code OpenCode upstream /api path restore', () => {
  test('keeps /api paths and restores missing prefix for legacy roots', () => {
    assert.equal(ensureOpenCodeApiUpstreamPath('/api/session/x/message'), '/api/session/x/message');
    assert.equal(ensureOpenCodeApiUpstreamPath('/session/x/message?directory=/r'), '/api/session/x/message?directory=/r');
    assert.equal(ensureOpenCodeApiUpstreamPath('/event'), '/api/event');
    assert.equal(ensureOpenCodeApiUpstreamPath('/api/global/event'), '/api/global/event');
  });

  test('final HTTP upstream URL includes /api for session reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchInput: string | undefined;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        fetchInput = String(input);
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await handleProxyBridgeMessage(
        { id: 'u1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session/ses_1/message?directory=/x' } },
        ctx,
        deps,
      );
      assert.equal(fetchInput, 'http://127.0.0.1:3902/api/session/ses_1/message?directory=/x');

      await handleProxyBridgeMessage(
        { id: 'u2', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );
      assert.equal(fetchInput, 'http://127.0.0.1:3902/api/config?directory=/x');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code execution write permit at dispatch', () => {
  test('classifies prompt writes vs interrupt and reads', () => {
    assert.equal(isBridgeExecutionWritePath('POST', '/api/session/x/prompt_async'), true);
    assert.equal(isBridgeExecutionWritePath('POST', '/api/session/x/interrupt'), false);
    assert.equal(isBridgeExecutionWritePath('GET', '/api/session/x/message'), false);
  });

  test('blocks write dispatch when status leaves connected after wait', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    try {
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      // waitForApiUrl sees connected; subsequent permit checks see connecting
      // (restart race after wait settled, before upstream dispatch).
      let statusCalls = 0;
      const manager = {
        getStatus: () => {
          statusCalls += 1;
          return statusCalls <= 2 ? 'connected' : 'connecting';
        },
        getApiUrl: () => 'http://127.0.0.1:3902',
        getOpenCodeAuthHeaders: () => ({}),
        onStatusChange: (cb: (s: string) => void) => {
          cb('connected');
          return { dispose: () => {} };
        },
      } as unknown as OpenCodeManager;
      const localCtx = { manager } as unknown as BridgeContext;

      const response = await handleProxyBridgeMessage(
        {
          id: 'w1',
          type: 'api:proxy',
          payload: {
            method: 'POST',
            path: '/api/session/ses_1/prompt_async',
            bodyBase64: Buffer.from('{}').toString('base64'),
          },
        },
        localCtx,
        deps,
      );
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 503);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('still allows GET diagnostics without connected permit after timeout path', async () => {
    // When never connected, waitForApiUrl returns null → unavailable for all.
    // When connected, GET proceeds.
    const originalFetch = globalThis.fetch;
    let fetchInput: string | undefined;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        fetchInput = String(input);
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const { ctx: localCtx } = createManagerCtx({
        status: 'connected',
        url: 'http://127.0.0.1:3902',
      });
      await handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session/ses_1/message' } },
        localCtx,
        deps,
      );
      assert.equal(fetchInput, 'http://127.0.0.1:3902/api/session/ses_1/message');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

  test('drops reasoning parts on exact GET when includeReasoning=false and keeps tokens.reasoning', async () => {
    const originalFetch = globalThis.fetch;
    let fetchUrl = '';
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        fetchUrl = String(input);
        return new Response(JSON.stringify({
          info: {
            id: 'msg_1',
            role: 'assistant',
            tokens: { input: 1, output: 2, reasoning: 42 },
          },
          parts: [
            { id: 'p_r', type: 'reasoning', text: 'secret chain' },
            { id: 'p_t', type: 'text', text: 'hello' },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'exact_reason_1',
          type: 'api:proxy',
          payload: {
            method: 'GET',
            path: '/session/ses_1/message/msg_1?directory=/repo&includeReasoning=false',
          },
        },
        ctx,
        deps,
      );

      assert.equal(response?.success, true);
      assert.equal(new URL(fetchUrl).searchParams.has('includeReasoning'), false);
      const body = JSON.parse((response?.data as { bodyText?: string }).bodyText ?? '') as {
        info: { tokens: { reasoning: number } };
        parts: Array<{ type: string; text?: string }>;
      };
      assert.equal(body.info.tokens.reasoning, 42);
      assert.deepEqual(body.parts, [{ id: 'p_t', type: 'text', text: 'hello' }]);
      assert.equal(JSON.stringify(body).includes('secret chain'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code session.messages list reasoning projection', () => {
  test('strips reasoning parts on list GET when includeReasoning=false', async () => {
    const originalFetch = globalThis.fetch;
    let fetchUrl = '';
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        fetchUrl = String(input);
        return new Response(JSON.stringify([
          {
            info: { id: 'm1', tokens: { reasoning: 3 } },
            parts: [
              { type: 'reasoning', text: 'hidden' },
              { type: 'text', text: 'visible' },
            ],
          },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'list_1',
          type: 'api:proxy',
          payload: {
            method: 'GET',
            path: '/session/ses_1/message?directory=/repo&includeReasoning=false',
          },
        },
        ctx,
        deps,
      );

      assert.equal(response?.success, true);
      assert.equal(new URL(fetchUrl).searchParams.has('includeReasoning'), false);
      const body = JSON.parse((response?.data as { bodyText?: string }).bodyText ?? '') as Array<{
        info: { tokens: { reasoning: number } };
        parts: unknown[];
      }>;
      assert.equal(body[0].info.tokens.reasoning, 3);
      assert.deepEqual(body[0].parts, [{ type: 'text', text: 'visible' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps reasoning parts on list GET by default', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const payload = [
        {
          info: { id: 'm1' },
          parts: [
            { type: 'reasoning', text: 'keep' },
            { type: 'text', text: 'ok' },
          ],
        },
      ];
      globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'list_2',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/session/ses_1/message?directory=/repo' },
        },
        ctx,
        deps,
      );

      const bodyText = (response?.data as { bodyText?: string }).bodyText ?? '';
      assert.equal(bodyText.includes('keep'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
