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

  test('summary query key includes transport, directory, session, message, and diffCount', async () => {
    const { sessionTurnChangesQueryKey } = await import('./sessionTurnChangesQueries');
    expect(sessionTurnChangesQueryKey({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      diffCount: 3,
    })).toEqual([
      'transport-test',
      'sessionTurnChanges',
      'summary',
      '/repo',
      'ses_1',
      'msg_1',
      3,
    ]);
  });

  test('file query key includes file path', async () => {
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
    const { sessionTurnChangesQueryOptions } = await import('./sessionTurnChangesQueries');
    const signal = new AbortController().signal;
    runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ file: 'a.ts', additions: 1, deletions: 0 }],
    }), { status: 200 }));

    const result = await sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
    }).queryFn({ signal });

    expect(result).toEqual({ files: [{ file: 'a.ts', additions: 1, deletions: 0 }] });
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      '/api/openchamber/sessions/ses_1/changes',
      expect.objectContaining({
        method: 'GET',
        signal,
        query: expect.objectContaining({
          messageID: 'msg_1',
          directory: '/repo',
        }),
      }),
    );
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('falls back to getSessionDiff only for 404/405/501', async () => {
    const { sessionTurnChangesQueryOptions } = await import('./sessionTurnChangesQueries');
    for (const status of [404, 405, 501]) {
      runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status }));
      getSessionDiffMock.mockResolvedValueOnce([
        { file: 'legacy.ts', additions: 2, deletions: 1, patch: '@@' },
      ]);

      const result = await sessionTurnChangesQueryOptions({
        sessionID: 'ses_1',
        directory: '/repo',
        messageID: 'msg_1',
      }).queryFn({ signal: new AbortController().signal });

      expect(result).toEqual({
        files: [{ file: 'legacy.ts', additions: 2, deletions: 1 }],
      });
    }
  });

  test('fallback passes the same AbortSignal to getSessionDiff', async () => {
    const { sessionTurnChangesQueryOptions } = await import('./sessionTurnChangesQueries');
    const signal = new AbortController().signal;
    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    getSessionDiffMock.mockResolvedValueOnce([
      { file: 'legacy.ts', additions: 1, deletions: 0 },
    ]);

    await sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
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
    const { sessionTurnChangesQueryOptions } = await import('./sessionTurnChangesQueries');
    const controller = new AbortController();
    controller.abort();
    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
    }).queryFn({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('keeps non-fallback HTTP errors as failures', async () => {
    const { sessionTurnChangesQueryOptions } = await import('./sessionTurnChangesQueries');
    runtimeFetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
    }).queryFn({ signal: new AbortController().signal })).rejects.toThrow(/500/);
    expect(getSessionDiffMock).not.toHaveBeenCalled();
  });

  test('file query returns exact diff and falls back with file filter', async () => {
    const { sessionTurnChangeFileQueryOptions } = await import('./sessionTurnChangesQueries');
    runtimeFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      diff: { file: 'a.ts', patch: '@@ host @@' },
    }), { status: 200 }));

    const host = await sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal: new AbortController().signal });
    expect(host).toEqual({ diff: { file: 'a.ts', patch: '@@ host @@' } });

    runtimeFetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    getSessionDiffMock.mockResolvedValueOnce([
      { file: 'a.ts', patch: '@@ legacy @@' },
      { file: 'b.ts', patch: '@@ other @@' },
    ]);
    const legacy = await sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).queryFn({ signal: new AbortController().signal });
    expect(legacy).toEqual({ diff: { file: 'a.ts', patch: '@@ legacy @@' } });
  });

  test('summary gcTime is 5 minutes and file gcTime is 60 seconds', async () => {
    const {
      sessionTurnChangesQueryOptions,
      sessionTurnChangeFileQueryOptions,
    } = await import('./sessionTurnChangesQueries');
    expect(sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
    }).gcTime).toBe(5 * 60_000);
    expect(sessionTurnChangeFileQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
      file: 'a.ts',
    }).gcTime).toBe(60_000);
    expect(sessionTurnChangesQueryOptions({
      sessionID: 'ses_1',
      directory: '/repo',
      messageID: 'msg_1',
    }).retry).toBe(false);
  });
});
