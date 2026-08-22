import { beforeEach, describe, expect, test, vi } from 'vitest';

const runtimeFetchMock = vi.fn();
const getSessionDiffMock = vi.fn();

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'transport-test',
}));

vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSessionDiff: (...args: unknown[]) => getSessionDiffMock(...args),
  },
}));

vi.mock('@/lib/queryRuntime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queryRuntime')>('@/lib/queryRuntime');
  return actual;
});

describe('sessionTurnChangesQueries', () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    getSessionDiffMock.mockReset();
  });

  test('file query key includes transport, directory, session, message, file, and diffCount', async () => {
    const { sessionTurnChangeFileQueryKey } = await import('./sessionTurnChangesQueries');
    expect(sessionTurnChangeFileQueryKey({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'src/a.ts',
      diffCount: 1,
    })).toEqual([
      'transport-test',
      'sessionTurnChanges',
      'file',
      '/repo',
      'ses_1',
      'msg_1',
      'src/a.ts',
      1,
    ]);
  });

  test('uses OpenChamber changes route on success and passes signal', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    const signal = new AbortController().signal;
    runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      diff: { file: 'a.ts', patch: '@@ host @@' },
    }), { status: 200 }));

    const result = await sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal });

    expect(result).toEqual({ diff: { file: 'a.ts', patch: '@@ host @@' } });
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      '/api/openchamber/sessions/ses_1/changes',
      expect.objectContaining({
        method: 'GET',
        signal,
        query: expect.objectContaining({
          messageID: 'msg_1',
          directory: '/repo',
          file: 'a.ts',
        }),
      }),
    );
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('file query falls back to getSessionDiff only for 404/405/501', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    for (const status of [404, 405, 501]) {
      runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status }));
      getSessionDiffMock.mockResolvedValueOnce([
        { file: 'a.ts', additions: 2, deletions: 1, patch: '@@ legacy @@' },
        { file: 'b.ts', additions: 0, deletions: 0, patch: '@@ other @@' },
      ]);

      const result = await sessionTurnChangeFileQueryOptions({
        sessionID: 'ses_1',
        directory: '/repo',
        messageID: 'msg_1',
        file: 'a.ts',
      }).queryFn({ signal: new AbortController().signal });

      expect(result).toEqual({ diff: { file: 'a.ts', additions: 2, deletions: 1, patch: '@@ legacy @@' } });
    }
  });

  test('fallback passes the same AbortSignal to getSessionDiff', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    const signal = new AbortController().signal;
    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    getSessionDiffMock.mockResolvedValueOnce([
      { file: 'a.ts', additions: 1, deletions: 0 },
    ]);

    await sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal });

    expect(getSessionDiffMock).toHaveBeenCalledWith(
      {
        sessionID: 'ses_1',
        directory: '/repo',
        messageID: 'msg_1',
      },
      { signal },
    );
  });

  test('does not start fallback when signal is already aborted', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    const controller = new AbortController();
    controller.abort();
    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('keeps non-fallback HTTP errors as failures', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    runtimeFetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal: new AbortController().signal })).rejects.toThrow(/500/);
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('legacy fallback miss throws change file not found', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    getSessionDiffMock.mockResolvedValueOnce([
      { file: 'b.ts', patch: '@@ other @@' },
    ]);

    await expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal: new AbortController().signal })).rejects.toThrow('change file not found');
  });

  test('file query gcTime is 60 seconds and retry is disabled', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).gcTime).toBe(60_000);
    expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).retry).toBe(false);
  });
});
