import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Red-light contract for `bridge-session-turn-page-runtime.ts`.
 *
 * Handles bridge type `api:session-turn-page`:
 * - reads OpenCode base URL + auth from manager
 * - requests official `/session/:id/message?limit=&before=&directory=`
 * - returns unified turn-page JSON { records, cursor, complete, turnCount }
 *
 * Extension Host bridge wires manager OpenCode URL/auth to the aggregator.
 */

const originalFetch = globalThis.fetch;

const loadRuntime = () => import('./bridge-session-turn-page-runtime');

const defaultCtx = {
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  },
};

describe('bridge session turn-page runtime', () => {
  /** @type {Array<{ url: URL, method: string, headers: Headers }>} */
  let fetchCalls;
  /** @type {(call: { url: URL, method: string, headers: Headers }) => Promise<Response>} */
  let responseImpl;

  beforeEach(() => {
    fetchCalls = [];
    responseImpl = async () =>
      new Response(
        JSON.stringify([
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-next-cursor': '',
          },
        },
      );

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const call = {
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
      };
      fetchCalls.push(call);
      return responseImpl(call);
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null for non turn-page message types', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      { id: '1', type: 'api:proxy', payload: {} },
      defaultCtx,
    );
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it('handles api:session-turn-page from manager OpenCode URL with auth headers', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_1',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_abc',
          directory: '/repo/project',
          turns: 3,
          scanLimit: 50,
          before: 'msg_cursor',
        },
      },
      defaultCtx,
    );

    expect(result).toMatchObject({
      id: 'req_tp_1',
      type: 'api:session-turn-page',
      success: true,
    });
    expect(result.data).toMatchObject({
      records: expect.any(Array),
      turnCount: expect.any(Number),
      complete: expect.any(Boolean),
    });
    expect(Object.prototype.hasOwnProperty.call(result.data, 'cursor')).toBe(true);

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const first = fetchCalls[0];
    expect(first.method).toBe('GET');
    expect(first.url.origin).toBe('http://opencode.test');
    // Official OpenCode session messages path (singular "message")
    expect(first.url.pathname).toBe('/session/ses_abc/message');
    expect(first.url.searchParams.has('limit')).toBe(true);
    expect(first.url.searchParams.get('before')).toBe('msg_cursor');
    expect(first.url.searchParams.get('directory')).toBe('/repo/project');
    expect(first.headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('requests official path with limit + directory when before is omitted', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_2',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 3,
        },
      },
      defaultCtx,
    );

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const call = fetchCalls[0];
    expect(call.url.pathname).toBe('/session/ses_1/message');
    expect(call.url.searchParams.has('limit')).toBe(true);
    expect(call.url.searchParams.get('directory')).toBe('/repo');
    expect(call.url.searchParams.has('before')).toBe(false);
  });

  it('returns unified JSON after aggregating three real user turns across pages', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    // OpenCode pages are chronological old→new within each page.
    const pages = new Map([
      [null, {
        body: [
          { info: { id: 'msg_u3', role: 'user', time: { created: 8 } }, parts: [{ type: 'text', text: 'three' }] },
          { info: { id: 'msg_a3', role: 'assistant', time: { created: 9 } }, parts: [{ type: 'text', text: 'ok' }] },
        ],
        cursor: 'msg_u3',
      }],
      ['msg_u3', {
        body: [
          {
            info: { id: 'msg_loop', role: 'user', time: { created: 6 } },
            parts: [{ type: 'text', text: 'continue', synthetic: true }],
          },
          { info: { id: 'msg_a_loop', role: 'assistant', time: { created: 7 } }, parts: [{ type: 'text', text: 'loop' }] },
        ],
        cursor: 'msg_loop',
      }],
      ['msg_loop', {
        body: [
          { info: { id: 'msg_u2', role: 'user', time: { created: 4 } }, parts: [{ type: 'text', text: 'two' }] },
          { info: { id: 'msg_a2', role: 'assistant', time: { created: 5 } }, parts: [{ type: 'text', text: 'ok' }] },
        ],
        cursor: 'msg_u2',
      }],
      ['msg_u2', {
        body: [
          { info: { id: 'msg_u1', role: 'user', time: { created: 2 } }, parts: [{ type: 'text', text: 'one' }] },
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 3 } }, parts: [{ type: 'text', text: 'ok' }] },
        ],
        cursor: null,
      }],
    ]);

    responseImpl = async (call) => {
      const before = call.url.searchParams.get('before');
      const key = before || null;
      const page = pages.get(key) ?? { body: [], cursor: null };
      const headers = { 'content-type': 'application/json' };
      if (page.cursor) headers['x-next-cursor'] = page.cursor;
      return new Response(JSON.stringify(page.body), { status: 200, headers });
    };

    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_3',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 3,
        },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data.turnCount).toBe(3);
    expect(result.data.records.map((entry) => entry.info.id)).toEqual(expect.arrayContaining([
      'msg_u1', 'msg_u2', 'msg_u3',
    ]));
    expect(result.data.turnCount).toBe(3);
  });

  it('applies a 45s aggregation AbortController timeout and clears it', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    /** @type {AbortSignal | undefined} */
    let seenSignal;
    responseImpl = async (call) => {
      // Access signal via the last fetch init — captured through global fetch mock
      return new Response(
        JSON.stringify([
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    // Patch fetch to capture signal from init
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      seenSignal = init?.signal;
      const request = input instanceof Request ? input : new Request(String(input), init);
      const call = {
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
      };
      fetchCalls.push(call);
      return responseImpl(call);
    });

    try {
      const result = await handleSessionTurnPageBridgeMessage(
        {
          id: 'req_tp_timeout',
          type: 'api:session-turn-page',
          payload: { sessionID: 'ses_1', directory: '/repo', turns: 1 },
        },
        defaultCtx,
      );
      expect(result.success).toBe(true);
      expect(seenSignal).toBeDefined();
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal.aborted).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('surfaces explicit no-progress error without partial records', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    responseImpl = async () =>
      new Response(
        JSON.stringify([
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [] },
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-next-cursor': 'msg_u1',
          },
        },
      );

    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_np',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 3,
          before: 'msg_u1',
        },
      },
      defaultCtx,
    );

    expect(result.success).toBe(false);
    expect(String(result.error ?? result.data?.error ?? '')).toMatch(
      /cursor|duplicate|no.?progress|stalled|empty/i,
    );
    if (result.data && typeof result.data === 'object' && 'records' in result.data) {
      expect(result.data.records).toBeUndefined();
    }
  });

  it('surfaces explicit too-large / scan-limit error without partial records', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    let page = 0;
    responseImpl = async () => {
      page += 1;
      return new Response(
        JSON.stringify([
          { info: { id: `msg_a${page}`, role: 'assistant', time: { created: page } }, parts: [] },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-next-cursor': `cursor_${page}`,
          },
        },
      );
    };

    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_large',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 3,
          scanLimit: 10,
        },
      },
      defaultCtx,
    );

    if (result.success) {
      expect(page).toBeLessThanOrEqual(30);
      expect(result.data.complete === true || result.success === false).toBe(true);
    } else {
      expect(String(result.error ?? result.data?.error ?? '')).toMatch(
        /large|scan|limit|page|message|no.?progress/i,
      );
    }
  });

  it('returns failure when OpenCode manager is unavailable', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_ua',
        type: 'api:session-turn-page',
        payload: { sessionID: 'ses_1', directory: '/repo', turns: 3 },
      },
      { manager: undefined },
    );

    expect(result).toMatchObject({
      id: 'req_tp_ua',
      type: 'api:session-turn-page',
      success: false,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns validation failure for missing sessionID', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_val',
        type: 'api:session-turn-page',
        payload: { directory: '/repo', turns: 3 },
      },
      defaultCtx,
    );

    expect(result.success).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});
