import { describe, expect, test } from 'vitest';

/**
 * Contract for `sessionTurnChangesRoute.ts`.
 *
 * Webview local route for GET `/api/openchamber/sessions/:id/changes`:
 * - identify path ahead of generic OpenCode proxy
 * - parse query (messageID, directory, optional file)
 * - dispatch `api:session-turn-changes` bridge
 * - GET success; non-GET → 405; illegal query → 400
 */

const loadRoute = () => import('./sessionTurnChangesRoute');

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

describe('isSessionTurnChangesRoute', () => {
  test('identifies only openchamber session changes routes', async () => {
    const { isSessionTurnChangesRoute } = await loadRoute();
    expect(isSessionTurnChangesRoute('/api/openchamber/sessions/ses_1/changes')).toBe(true);
    expect(isSessionTurnChangesRoute('/api/openchamber/sessions/ses_1/changes/')).toBe(true);
    expect(isSessionTurnChangesRoute('/api/openchamber/sessions/ses_1/messages')).toBe(false);
    expect(isSessionTurnChangesRoute('/api/openchamber/sessions//changes')).toBe(false);
    expect(isSessionTurnChangesRoute('/session/ses_1/diff')).toBe(false);
  });
});

describe('parseSessionTurnChangesQuery', () => {
  test('extracts sessionID, messageID, directory, and optional file', async () => {
    const { parseSessionTurnChangesQuery } = await loadRoute();
    const parsed = parseSessionTurnChangesQuery(
      '/api/openchamber/sessions/ses_abc/changes',
      new URLSearchParams({
        messageID: 'msg_1',
        directory: '/repo a',
        file: 'src/a.ts',
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      sessionID: 'ses_abc',
      messageID: 'msg_1',
      directory: '/repo a',
      file: 'src/a.ts',
    });
  });

  test('rejects missing messageID', async () => {
    const { parseSessionTurnChangesQuery } = await loadRoute();
    const parsed = parseSessionTurnChangesQuery(
      '/api/openchamber/sessions/ses_1/changes',
      new URLSearchParams({ directory: '/repo' }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('invalid_message');
  });

  test('rejects control characters in file', async () => {
    const { parseSessionTurnChangesQuery } = await loadRoute();
    const parsed = parseSessionTurnChangesQuery(
      '/api/openchamber/sessions/ses_1/changes',
      new URLSearchParams({ messageID: 'msg_1', file: 'a\u0000.ts' }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('invalid_file');
  });

  test('rejects DEL (0x7f) in file with 400 invalid_file', async () => {
    const { parseSessionTurnChangesQuery } = await loadRoute();
    const parsed = parseSessionTurnChangesQuery(
      '/api/openchamber/sessions/ses_1/changes',
      new URLSearchParams({ messageID: 'msg_1', file: `a${String.fromCharCode(0x7f)}.ts` }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('invalid_file');
      expect(parsed.error).toBe('file is invalid');
    }
  });
});

describe('handleSessionTurnChangesRoute', () => {
  test('GET L2 success dispatches api:session-turn-changes without file', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder(async () => ({
      files: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
    }));

    const response = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({
        messageID: 'msg_1',
        directory: '/repo',
      }),
      sendBridgeMessage,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
    });
    expect(calls[0]).toEqual({
      type: 'api:session-turn-changes',
      payload: {
        sessionID: 'ses_1',
        messageID: 'msg_1',
        directory: '/repo',
        file: undefined,
      },
    });
  });

  test('GET L3 success passes file through', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder(async () => ({
      diff: { file: 'src/a.ts', patch: '@@ -1 +1 @@\n+x' },
    }));

    const response = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({
        messageID: 'msg_1',
        file: 'src/a.ts',
      }),
      sendBridgeMessage,
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.payload).toMatchObject({ file: 'src/a.ts' });
    expect(await response.json()).toEqual({
      diff: { file: 'src/a.ts', patch: '@@ -1 +1 @@\n+x' },
    });
  });

  test('non-GET methods return 405', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder();
    const response = await handleSessionTurnChangesRoute({
      method: 'POST',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({ messageID: 'msg_1' }),
      sendBridgeMessage,
    });
    expect(response.status).toBe(405);
    expect(calls.length).toBe(0);
  });

  test('maps change_not_found bridge error to 404', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { sendBridgeMessage } = createBridgeRecorder(async () => {
      const error = new Error('change file not found') as Error & {
        data?: { code: string; status: number };
      };
      error.data = { code: 'change_not_found', status: 404 };
      throw error;
    });
    const response = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({ messageID: 'msg_1', file: 'missing.ts' }),
      sendBridgeMessage,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'change file not found',
      code: 'change_not_found',
    });
  });

  test('maps structured bridge codes to 400/404/499/503', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();

    const cases: Array<{
      code: string;
      status: number;
      expectedStatus: number;
      expectedError: string;
    }> = [
      { code: 'invalid_message', status: 400, expectedStatus: 400, expectedError: 'messageID is required' },
      { code: 'invalid_file', status: 400, expectedStatus: 400, expectedError: 'file is invalid' },
      { code: 'invalid_session', status: 400, expectedStatus: 400, expectedError: 'sessionID is required' },
      { code: 'not_found', status: 404, expectedStatus: 404, expectedError: 'not found' },
      { code: 'unavailable', status: 503, expectedStatus: 503, expectedError: 'OpenCode manager is unavailable' },
      { code: 'aborted', status: 499, expectedStatus: 499, expectedError: 'aborted' },
    ];

    for (const item of cases) {
      const { sendBridgeMessage } = createBridgeRecorder(async () => {
        const error = new Error('ignored English text') as Error & {
          data?: { code: string; status: number };
        };
        error.data = { code: item.code, status: item.status };
        throw error;
      });
      const response = await handleSessionTurnChangesRoute({
        method: 'GET',
        pathname: '/api/openchamber/sessions/ses_1/changes',
        searchParams: new URLSearchParams({ messageID: 'msg_1' }),
        sendBridgeMessage,
      });
      expect(response.status).toBe(item.expectedStatus);
      expect(await response.json()).toEqual({
        error: item.expectedError,
        code: item.code,
      });
    }
  });

  test('maps AbortError to 499 without reverse-looking up English message', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { sendBridgeMessage } = createBridgeRecorder(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    const response = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({ messageID: 'msg_1' }),
      sendBridgeMessage,
    });
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: 'aborted', code: 'aborted' });
  });

  test('maps unknown bridge errors to 502 upstream', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();

    const messageOnly = createBridgeRecorder(async () => {
      throw new Error('change file not found');
    });
    const messageOnlyResponse = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({ messageID: 'msg_1', file: 'missing.ts' }),
      sendBridgeMessage: messageOnly.sendBridgeMessage,
    });
    expect(messageOnlyResponse.status).toBe(502);
    expect(await messageOnlyResponse.json()).toEqual({
      error: 'upstream',
      code: 'upstream',
    });

    const unknownCode = createBridgeRecorder(async () => {
      const error = new Error('boom') as Error & { data?: { code: string; status: number } };
      error.data = { code: 'totally_unknown', status: 418 };
      throw error;
    });
    const unknownResponse = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({ messageID: 'msg_1' }),
      sendBridgeMessage: unknownCode.sendBridgeMessage,
    });
    expect(unknownResponse.status).toBe(502);
    expect(await unknownResponse.json()).toEqual({
      error: 'upstream',
      code: 'upstream',
    });
  });

  test('rejects DEL file via route parse before bridge dispatch', async () => {
    const { handleSessionTurnChangesRoute } = await loadRoute();
    const { calls, sendBridgeMessage } = createBridgeRecorder();
    const response = await handleSessionTurnChangesRoute({
      method: 'GET',
      pathname: '/api/openchamber/sessions/ses_1/changes',
      searchParams: new URLSearchParams({
        messageID: 'msg_1',
        file: `evil${String.fromCharCode(0x7f)}.ts`,
      }),
      sendBridgeMessage,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'file is invalid',
      code: 'invalid_file',
    });
    expect(calls.length).toBe(0);
  });
});
