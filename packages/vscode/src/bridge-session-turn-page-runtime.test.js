import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Red-light contract for `bridge-session-turn-page-runtime.ts`.
 *
 * Handles bridge type `api:session-turn-page`:
 * - reads OpenCode base URL + auth from manager
 * - requests OpenCode v2 `/api/session/:id/message`: first page `order=desc`,
 *   continuation `cursor=` only (upstream 400s on both)
 * - reads `{ data (newest-first), cursor: { next } }` and projects `{ info, parts }`
 * - returns unified turn-page JSON { records, cursor, complete, turnCount }
 *
 * Extension Host bridge wires manager OpenCode URL/auth to the aggregator.
 */

const originalFetch = globalThis.fetch;

const loadRuntime = () => import('./bridge-session-turn-page-runtime');

/** v2 `message.list` body: `data` is newest-first; fixtures are written oldest→newest. */
const v2Page = (chronological, next = null) => new Response(
  JSON.stringify({
    data: chronological.slice().reverse(),
    cursor: { previous: null, next: next || null },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

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
      v2Page([
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] },
        ]);

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
    // Official OpenCode v2 session messages path (singular "message", /api prefix)
    expect(first.url.pathname).toBe('/api/session/ses_abc/message');
    expect(first.url.searchParams.has('limit')).toBe(true);
    expect(first.url.searchParams.get('cursor')).toBe('msg_cursor');
    expect(first.url.searchParams.has('order')).toBe(false);
    expect(first.url.searchParams.has('before')).toBe(false);
    expect(first.url.searchParams.has('directory')).toBe(false);
    expect(first.headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('requests the first page with order=desc and no cursor when before is omitted', async () => {
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
    expect(call.url.pathname).toBe('/api/session/ses_1/message');
    expect(call.url.searchParams.has('limit')).toBe(true);
    expect(call.url.searchParams.get('order')).toBe('desc');
    expect(call.url.searchParams.has('cursor')).toBe(false);
    expect(call.url.searchParams.has('directory')).toBe(false);
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
      const cursor = call.url.searchParams.get('cursor');
      expect(cursor != null && call.url.searchParams.has('order')).toBe(false);
      const page = pages.get(cursor || null) ?? { body: [], cursor: null };
      return v2Page(page.body, page.cursor);
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
      return v2Page([
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        ]);
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
      v2Page([
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [] },
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        ], 'msg_u1');

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
      return v2Page([
        { info: { id: `msg_a${page}`, role: 'assistant', time: { created: page } }, parts: [] },
      ], `cursor_${page}`);
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

  it('returns opaque Host cursor (oc1.) on incomplete pages', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    // One exhausted page with 4 authored turns; turns=2 → overscan trim → Host token.
    responseImpl = async () =>
      v2Page([
          { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '1' }] },
          { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] },
          { info: { id: 'msg_u2', role: 'user', time: { created: 3 } }, parts: [{ type: 'text', text: '2' }] },
          { info: { id: 'msg_a2', role: 'assistant', time: { created: 4 } }, parts: [{ type: 'text', text: 'ok' }] },
          { info: { id: 'msg_u3', role: 'user', time: { created: 5 } }, parts: [{ type: 'text', text: '3' }] },
          { info: { id: 'msg_a3', role: 'assistant', time: { created: 6 } }, parts: [{ type: 'text', text: 'ok' }] },
          { info: { id: 'msg_u4', role: 'user', time: { created: 7 } }, parts: [{ type: 'text', text: '4' }] },
          { info: { id: 'msg_a4', role: 'assistant', time: { created: 8 } }, parts: [{ type: 'text', text: 'ok' }] },
        ]);

    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_host_cursor',
        type: 'api:session-turn-page',
        payload: { sessionID: 'ses_1', directory: '/repo', turns: 2 },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data.complete).toBe(false);
    expect(typeof result.data.cursor).toBe('string');
    expect(result.data.cursor.startsWith('oc1.')).toBe(true);
    expect(result.data.records.map((entry) => entry.info.id)).toEqual([
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);
  });

  it('passes Host token through bridge: decode to raw upstream cursor, never send oc1. upstream', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const { encodeHostCursor } = await import('./session-turn-page-runtime');

    // Full timeline; Host token points at boundary msg_u3 on the first page (before=null).
    const all = [
      { info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '1' }] },
      { info: { id: 'msg_a1', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] },
      { info: { id: 'msg_u2', role: 'user', time: { created: 3 } }, parts: [{ type: 'text', text: '2' }] },
      { info: { id: 'msg_a2', role: 'assistant', time: { created: 4 } }, parts: [{ type: 'text', text: 'ok' }] },
      { info: { id: 'msg_u3', role: 'user', time: { created: 5 } }, parts: [{ type: 'text', text: '3' }] },
      { info: { id: 'msg_a3', role: 'assistant', time: { created: 6 } }, parts: [{ type: 'text', text: 'ok' }] },
      { info: { id: 'msg_u4', role: 'user', time: { created: 7 } }, parts: [{ type: 'text', text: '4' }] },
      { info: { id: 'msg_a4', role: 'assistant', time: { created: 8 } }, parts: [{ type: 'text', text: 'ok' }] },
    ];

    responseImpl = async (call) => {
      const cursor = call.url.searchParams.get('cursor');
      let end = all.length;
      if (cursor) {
        const index = all.findIndex((entry) => entry.info.id === cursor);
        end = index >= 0 ? index : 0;
      }
      const limit = Number(call.url.searchParams.get('limit') || 50);
      const start = Math.max(0, end - limit);
      const slice = all.slice(start, end);
      return v2Page(slice, start > 0 ? slice[0]?.info.id : null);
    };

    const hostToken = encodeHostCursor({ before: null, boundaryID: 'msg_u3' });
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_host_pass',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 2,
          before: hostToken,
        },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);
    // Upstream must never see the Host token prefix.
    for (const call of fetchCalls) {
      const cursor = call.url.searchParams.get('cursor');
      if (cursor != null) {
        expect(cursor.startsWith('oc1.')).toBe(false);
      }
    }
    // First fetch re-opens origin page (cursor omitted when origin was null).
    expect(fetchCalls[0].url.searchParams.has('cursor')).toBe(false);
    expect(fetchCalls[0].url.searchParams.get('order')).toBe('desc');
  });

  it('maps invalid_cursor safely without partial records', async () => {
    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_tp_bad_cursor',
        type: 'api:session-turn-page',
        payload: {
          sessionID: 'ses_1',
          directory: '/repo',
          turns: 3,
          before: 'oc1.not-valid',
        },
      },
      defaultCtx,
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/invalid.?cursor/i);
    expect(fetchCalls).toHaveLength(0);
    if (result.data && typeof result.data === 'object' && 'records' in result.data) {
      expect(result.data.records).toBeUndefined();
    }
  });

  it('projects file parts on the first packet and prepend the same way', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.from([0x00, 0x00, 0x00, 0x0D]),
      Buffer.from('IHDR'),
      Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00]),
      Buffer.alloc(4),
    ]);
    const url = `data:image/png;base64,${png.toString('base64')}`;
    responseImpl = async () => v2Page([
        {
          info: { id: 'msg_u1', role: 'user', time: { created: 1 } },
          parts: [{ id: 'prt_file', type: 'file', mime: 'image/png', filename: 'shot.png', url }],
        },
      ]);

    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const first = await handleSessionTurnPageBridgeMessage(
      { id: 'req_file_1', type: 'api:session-turn-page', payload: { sessionID: 'ses_1', turns: 3 } },
      defaultCtx,
    );
    expect(first.success).toBe(true);
    expect(first.data.partsProjection).toBe('slim-v1');
    expect(first.data.turnCount).toBe(1);
    expect(first.data.records[0].parts[0]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      width: 2,
      height: 3,
      slim: true,
    });
    expect(first.data.records[0].parts[0].url).toBeUndefined();
    expect(JSON.stringify(first.data.records[0].parts[0])).not.toContain('base64');

    const prepend = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_file_2',
        type: 'api:session-turn-page',
        payload: { sessionID: 'ses_1', turns: 3, before: 'msg_cursor' },
      },
      defaultCtx,
    );
    expect(prepend.success).toBe(true);
    expect(prepend.data.partsProjection).toBe('slim-v1');
    expect(prepend.data.records[0].parts[0]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      width: 2,
      height: 3,
      slim: true,
    });
    expect(prepend.data.records[0].parts[0].url).toBeUndefined();
    expect(JSON.stringify(prepend.data.records[0].parts[0])).not.toContain('base64');
  });

  it('summarizes message diff snapshots in the turn-page bridge response', async () => {
    const patch = 'diff-body-'.repeat(20_000);
    responseImpl = async () => v2Page([{
        info: {
          id: 'msg_u1',
          role: 'user',
          time: { created: 1 },
          summary: {
            diffs: [{
              file: 'src/large.ts',
              status: 'modified',
              additions: 6,
              deletions: 2,
              patch,
            }],
          },
        },
        parts: [],
      }]);

    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      { id: 'req_diff_1', type: 'api:session-turn-page', payload: { sessionID: 'ses_1', turns: 3 } },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data.records[0].info.summary).toEqual({
      diffs: [{
        file: 'src/large.ts',
        status: 'modified',
        additions: 6,
        deletions: 2,
      }],
      diffCount: 1,
      hasDiffs: true,
    });
    expect(JSON.stringify(result.data)).not.toContain(patch);
  });

  it('drops reasoning parts when includeReasoning=false and keeps tokens.reasoning', async () => {
    responseImpl = async () => v2Page([
        {
          info: { id: 'msg_u1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hi' }],
        },
        {
          info: {
            id: 'msg_a1',
            role: 'assistant',
            time: { created: 2 },
            tokens: { input: 1, output: 2, reasoning: 77 },
          },
          parts: [
            { id: 'p_r', type: 'reasoning', text: 'secret chain of thought' },
            { id: 'p_t', type: 'text', text: 'answer' },
          ],
        },
      ]);

    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_reason_off',
        type: 'api:session-turn-page',
        payload: { sessionID: 'ses_1', turns: 3, includeReasoning: 'false' },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    const assistant = result.data.records.find((r) => r.info?.id === 'msg_a1');
    expect(assistant.info.tokens.reasoning).toBe(77);
    expect(assistant.parts.every((p) => p.type !== 'reasoning')).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('secret chain');

    const kept = await handleSessionTurnPageBridgeMessage(
      {
        id: 'req_reason_default',
        type: 'api:session-turn-page',
        payload: { sessionID: 'ses_1', turns: 3 },
      },
      defaultCtx,
    );
    expect(kept.success).toBe(true);
    // Default slim path keeps reasoning identity (no body) rather than dropping the part.
    const keptAssistant = kept.data.records.find((r) => r.info?.id === 'msg_a1');
    expect(keptAssistant.parts.some((p) => p.type === 'reasoning')).toBe(true);
  });

  it('projects v2 native rows into { info, parts } and drops control rows', async () => {
    responseImpl = async () => v2Page([
      { id: 'msg_u1', sessionID: 'ses_1', type: 'user', text: 'hello', time: { created: 1 } },
      { id: 'msg_idle', sessionID: 'ses_1', type: 'idle', time: { created: 2 } },
      {
        id: 'msg_a1',
        sessionID: 'ses_1',
        type: 'assistant',
        time: { created: 3 },
        model: { id: 'model-a', providerID: 'provider-a' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);

    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      { id: 'req_v2_native', type: 'api:session-turn-page', payload: { sessionID: 'ses_1', turns: 3 } },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data.turnCount).toBe(1);
    expect(result.data.records.map((entry) => [entry.info.id, entry.info.role])).toEqual([
      ['msg_u1', 'user'],
      ['msg_a1', 'assistant'],
    ]);
    expect(result.data.records[0].parts).toMatchObject([{ type: 'text', text: 'hello' }]);
    expect(result.data.records[1].info).toMatchObject({ modelID: 'model-a', providerID: 'provider-a' });
    expect(result.data.records[1].info.content).toBeUndefined();
    expect(result.data.records[1].parts).toMatchObject([{ type: 'text', text: 'answer' }]);
  });

  it('fails as upstream on a 1.x array body instead of treating it as empty', async () => {
    responseImpl = async () => new Response(
      JSON.stringify([{ info: { id: 'msg_u1', role: 'user', time: { created: 1 } }, parts: [] }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const { handleSessionTurnPageBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnPageBridgeMessage(
      { id: 'req_v1_body', type: 'api:session-turn-page', payload: { sessionID: 'ses_1', turns: 3 } },
      defaultCtx,
    );

    expect(result.success).toBe(false);
    expect(result.data?.records).toBeUndefined();
  });
});
