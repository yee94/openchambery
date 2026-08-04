import { describe, expect, test } from 'bun:test';

/**
 * Contract for `sessionTurnPageRoute.ts`.
 *
 * Webview local route for GET `/api/openchamber/sessions/:id/messages`:
 * - identify path ahead of generic OpenCode proxy
 * - parse query (directory, before, turns, scanLimit)
 * - dispatch `api:session-turn-page` bridge
 * - GET success; non-GET → 405; illegal query → 400
 */

const loadRoute = () => import('./sessionTurnPageRoute');

type BridgeCall = { type: string; payload?: unknown };

const createBridgeRecorder = (impl?: (type: string, payload?: unknown) => Promise<unknown>) => {
  const calls: BridgeCall[] = [];
  const sendBridgeMessage = async (type: string, payload?: unknown) => {
    calls.push({ type, payload });
    if (impl) return impl(type, payload);
    throw new Error('bridge must not run');
  };
  return { calls, sendBridgeMessage };
};

describe('isSessionTurnPageRoute', () => {
  test('identifies only openchamber session messages turn-page routes', async () => {
    const { isSessionTurnPageRoute } = await loadRoute();
    expect(isSessionTurnPageRoute('/api/openchamber/sessions/ses_1/messages')).toBe(true);
    expect(isSessionTurnPageRoute('/api/openchamber/sessions/ses%2Fwith%2Fslash/messages')).toBe(true);
    expect(isSessionTurnPageRoute('/api/openchamber/sessions/ses_1/messages/')).toBe(true);

    expect(isSessionTurnPageRoute('/api/openchamber/message-queue')).toBe(false);
    expect(isSessionTurnPageRoute('/api/openchamber/tunnel/status')).toBe(false);
    expect(isSessionTurnPageRoute('/api/session/ses_1/message')).toBe(false);
    expect(isSessionTurnPageRoute('/api/sessions/ses_1/status')).toBe(false);
    expect(isSessionTurnPageRoute('/api/openchamber/sessions/ses_1')).toBe(false);
    expect(isSessionTurnPageRoute('/api/openchamber/sessions//messages')).toBe(false);
  });
});

describe('parseSessionTurnPageQuery', () => {
  test('extracts sessionID, directory, before, turns, scanLimit from path + search', async () => {
    const { parseSessionTurnPageQuery } = await loadRoute();
    const parsed = parseSessionTurnPageQuery(
      '/api/openchamber/sessions/ses_abc/messages',
      new URLSearchParams({
        directory: '/repo a',
        before: 'msg_cursor',
        turns: '3',
        scanLimit: '100',
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      sessionID: 'ses_abc',
      directory: '/repo a',
      before: 'msg_cursor',
      turns: 3,
      scanLimit: 100,
    });
  });

  test('decodes encoded sessionID segments', async () => {
    const { parseSessionTurnPageQuery } = await loadRoute();
    const parsed = parseSessionTurnPageQuery(
      `/api/openchamber/sessions/${encodeURIComponent('ses/a b')}/messages`,
      new URLSearchParams({ directory: '/repo' }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.sessionID).toBe('ses/a b');
    }
  });

  test('defaults turns and scanLimit within valid ranges when omitted', async () => {
    const { parseSessionTurnPageQuery } = await loadRoute();
    const parsed = parseSessionTurnPageQuery(
      '/api/openchamber/sessions/ses_1/messages',
      new URLSearchParams({ directory: '/repo' }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.turns).toBeGreaterThanOrEqual(1);
      expect(parsed.turns).toBeLessThanOrEqual(10);
      if (parsed.scanLimit != null) {
        expect(parsed.scanLimit).toBeGreaterThanOrEqual(10);
        expect(parsed.scanLimit).toBeLessThanOrEqual(200);
      }
    }
  });

  test('rejects turns outside 1..10', async () => {
    const { parseSessionTurnPageQuery } = await loadRoute();
    for (const turns of ['0', '11', '-1', 'abc']) {
      const parsed = parseSessionTurnPageQuery(
        '/api/openchamber/sessions/ses_1/messages',
        new URLSearchParams({ directory: '/repo', turns }),
      );
      expect(parsed.ok).toBe(false);
    }
  });

  test('rejects scanLimit outside 10..200', async () => {
    const { parseSessionTurnPageQuery } = await loadRoute();
    for (const scanLimit of ['9', '201', '0', 'nope']) {
      const parsed = parseSessionTurnPageQuery(
        '/api/openchamber/sessions/ses_1/messages',
        new URLSearchParams({ directory: '/repo', turns: '3', scanLimit }),
      );
      expect(parsed.ok).toBe(false);
    }
  });
});

describe('handleSessionTurnPageRoute', () => {
  test('GET success dispatches api:session-turn-page and returns unified JSON', async () => {
    const { handleSessionTurnPageRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder(async () => ({
      records: [
        { info: { id: 'msg_u1', role: 'user' }, parts: [] },
        { info: { id: 'msg_a1', role: 'assistant' }, parts: [] },
      ],
      cursor: 'msg_u1',
      complete: false,
      turnCount: 1,
    }));

    const response = await handleSessionTurnPageRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/messages',
      searchParams: new URLSearchParams({
        directory: '/repo',
        turns: '3',
        scanLimit: '50',
        before: 'msg_old',
      }),
      sendBridgeMessage,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      records: unknown[];
      cursor: string | null;
      complete: boolean;
      turnCount: number;
    };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.cursor).toBe('msg_u1');
    expect(body.complete).toBe(false);
    expect(body.turnCount).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.type).toBe('api:session-turn-page');
    expect(calls[0]?.payload).toEqual({
      sessionID: 'ses_1',
      directory: '/repo',
      turns: 3,
      scanLimit: 50,
      before: 'msg_old',
    });
  });

  test('non-GET methods return 405', async () => {
    const { handleSessionTurnPageRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder();

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await handleSessionTurnPageRoute({
        method,
        pathname: '/api/openchamber/sessions/ses_1/messages',
        searchParams: new URLSearchParams({ directory: '/repo', turns: '3' }),
        sendBridgeMessage,
      });
      expect(response.status).toBe(405);
      expect(calls.length).toBe(0);
    }
  });

  test('illegal query returns 400 without calling bridge', async () => {
    const { handleSessionTurnPageRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder();

    const response = await handleSessionTurnPageRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/messages',
      searchParams: new URLSearchParams({ directory: '/repo', turns: '99' }),
      sendBridgeMessage,
    });

    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('route match is intended to run before generic OpenCode proxy paths', async () => {
    const { isSessionTurnPageRoute } = await loadRoute();
    // Contract: session turn-page is an OpenChamber-owned route, not
    // `/api/session/:id/message` proxy. Callers must check isSessionTurnPageRoute
    // before falling through to api:proxy.
    expect(isSessionTurnPageRoute('/api/openchamber/sessions/ses_x/messages')).toBe(true);
    expect(isSessionTurnPageRoute('/api/session/ses_x/message')).toBe(false);
  });
});
