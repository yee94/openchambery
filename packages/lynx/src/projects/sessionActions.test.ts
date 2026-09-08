import { describe, expect, test } from 'vitest';

import {
  archiveLynxSession,
  archiveLynxSessions,
  copyLynxText,
  createLynxSession,
  deleteLynxSession,
  fetchLynxSessionShareUrl,
  renameLynxSession,
  requestLynxSessionSmartTitle,
  shareLynxSession,
  toggleLynxSessionPin,
  unarchiveLynxSession,
  unshareLynxSession,
} from './sessionActions';

describe('Lynx session menu actions', () => {
  test('archive/rename/delete hit OpenCode session routes', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ id: 'ses_1', title: 'T' }) };
    };
    expect(await archiveLynxSession(runtimeFetch, { sessionId: 'ses_1', directory: '/repo', archivedAt: 42 })).toEqual({ status: 'ok' });
    expect(await renameLynxSession(runtimeFetch, { sessionId: 'ses_1', title: 'New', directory: '/repo' })).toEqual({ status: 'ok' });
    expect(await deleteLynxSession(runtimeFetch, { sessionId: 'ses_1', directory: '/repo' })).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/session/ses_1?directory=%2Frepo' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ time: { archived: 42 } });
    expect(calls[1]?.method).toBe('PATCH');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ title: 'New' });
    expect(calls[2]).toMatchObject({ method: 'DELETE' });
  });


  test('unarchive patches time.archived = 0; mirrors archive error shape', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ id: 'ses_1' }) };
    };
    expect(await unarchiveLynxSession(runtimeFetch, { sessionId: 'ses_1', directory: '/repo' })).toEqual({
      status: 'ok',
    });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/session/ses_1?directory=%2Frepo' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ time: { archived: 0 } });

    expect(await unarchiveLynxSession(null, { sessionId: 'ses_1' })).toEqual({ status: 'no-runtime' });
    const fail = await unarchiveLynxSession(async () => ({ ok: false, status: 500, json: async () => ({}) }), {
      sessionId: 'ses_1',
    });
    expect(fail).toEqual({
      status: 'failed',
      error: 'session.unarchive failed (500)',
      httpStatus: 500,
    });
  });

  test('create session returns id; no-runtime / HTTP failure are honest', async () => {
    expect(await createLynxSession(null)).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ses_new', directory: '/proj' }),
    });
    const created = await createLynxSession(runtimeFetch, { directory: '/proj' });
    expect(created).toEqual({ status: 'ok', sessionId: 'ses_new', directory: '/proj', title: undefined });

    const fail = await archiveLynxSession(async () => ({ ok: false, status: 500, json: async () => ({}) }), {
      sessionId: 'ses_1',
    });
    expect(fail.status).toBe('failed');
  });

  test('toggle pin uses session-index pin routes', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string }) => {
      calls.push({ path, method: init?.method });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    expect(await toggleLynxSessionPin(runtimeFetch, { sessionId: 'ses_1', pinned: false })).toEqual({ status: 'ok' });
    expect(await toggleLynxSessionPin(runtimeFetch, { sessionId: 'ses_1', pinned: true })).toEqual({ status: 'ok' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[1]?.method).toBe('DELETE');
  });
});

describe('Lynx session share / unshare', () => {
  test('share posts OpenCode /session/:id/share and returns url', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string }) => {
      calls.push({ path, method: init?.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ses_1', share: { url: 'https://share.example/a' } }),
      };
    };
    expect(await shareLynxSession(runtimeFetch, { sessionId: 'ses_1', directory: '/repo' })).toEqual({
      status: 'ok',
      shareUrl: 'https://share.example/a',
    });
    expect(calls[0]).toEqual({ path: '/session/ses_1/share?directory=%2Frepo', method: 'POST' });
    expect(await unshareLynxSession(runtimeFetch, { sessionId: 'ses_1', directory: '/repo' })).toEqual({
      status: 'ok',
    });
    expect(calls[1]).toEqual({ path: '/session/ses_1/share?directory=%2Frepo', method: 'DELETE' });
  });

  test('share/unshare never fake-success on HTTP failure', async () => {
    expect(await shareLynxSession(null, { sessionId: 'ses_1' })).toEqual({ status: 'no-runtime' });
    const fail = await shareLynxSession(async () => ({ ok: false, status: 500, json: async () => ({}) }), {
      sessionId: 'ses_1',
    });
    expect(fail.status).toBe('failed');
    const unshareFail = await unshareLynxSession(async () => ({ ok: false, status: 404, json: async () => ({}) }), {
      sessionId: 'ses_1',
    });
    expect(unshareFail.status).toBe('failed');
  });

  test('fetch share url via GET /session/:id', async () => {
    const result = await fetchLynxSessionShareUrl(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { share: { url: 'https://share.example/b' } } }),
    }), { sessionId: 'ses_1' });
    expect(result).toEqual({ status: 'ok', shareUrl: 'https://share.example/b' });
  });

  test('copyLynxText reports unavailable without clipboard', async () => {
    const result = await copyLynxText('https://share.example/a');
    expect(result.status === 'ok' || result.status === 'unavailable').toBe(true);
    expect(await copyLynxText('')).toMatchObject({ status: 'unavailable' });
  });
});

describe('requestLynxSessionSmartTitle', () => {
  test('GET then PATCH titleRefresh.requestedAt; preserves lastAutoTitle', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body });
      if ((init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ses_1',
            title: 'Old Title',
            metadata: {
              openchamber: {
                titleRefresh: { lastAutoTitle: 'prior', activityUpdatedAt: 9 },
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ses_1' }) };
    };
    const before = Date.now();
    expect(await requestLynxSessionSmartTitle(runtimeFetch, { sessionId: 'ses_1', directory: '/repo' })).toEqual({
      status: 'ok',
    });
    const after = Date.now();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/session/ses_1?directory=%2Frepo' });
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: '/session/ses_1?directory=%2Frepo' });
    const body = JSON.parse(calls[1]!.body!);
    const titleRefresh = body.metadata.openchamber.titleRefresh;
    expect(titleRefresh.lastAutoTitle).toBe('Old Title');
    expect(titleRefresh.activityUpdatedAt).toBe(9);
    expect(typeof titleRefresh.requestedAt).toBe('number');
    expect(titleRefresh.requestedAt).toBeGreaterThanOrEqual(before);
    expect(titleRefresh.requestedAt).toBeLessThanOrEqual(after);
  });

  test('preserves existing lastAutoTitle when session title empty', async () => {
    const calls: Array<{ body?: string; method?: string }> = [];
    const runtimeFetch = async (_path: string, init?: { method?: string; body?: string }) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body });
      if ((init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ses_1',
            title: '   ',
            metadata: { openchamber: { titleRefresh: { lastAutoTitle: 'kept' } } },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    expect(await requestLynxSessionSmartTitle(runtimeFetch, { sessionId: 'ses_1' })).toEqual({ status: 'ok' });
    const body = JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!);
    expect(body.metadata.openchamber.titleRefresh.lastAutoTitle).toBe('kept');
  });

  test('no-runtime and HTTP failure are honest (never fake-success)', async () => {
    expect(await requestLynxSessionSmartTitle(null, { sessionId: 'ses_1' })).toEqual({ status: 'no-runtime' });
    const getFail = await requestLynxSessionSmartTitle(
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      { sessionId: 'ses_1' },
    );
    expect(getFail).toEqual({
      status: 'failed',
      error: 'session.get failed (404)',
      httpStatus: 404,
    });
    let n = 0;
    const patchFail = await requestLynxSessionSmartTitle(async () => {
      n += 1;
      if (n === 1) {
        return { ok: true, status: 200, json: async () => ({ id: 'ses_1', title: 'T', metadata: {} }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }, { sessionId: 'ses_1' });
    expect(patchFail).toEqual({
      status: 'failed',
      error: 'session.smartTitle failed (500)',
      httpStatus: 500,
    });
  });
});

describe('archiveLynxSessions + delete cascade', () => {
  test('archiveLynxSessions reports archivedIds/failedIds honestly', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const runtimeFetch = async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path.includes('ses_fail')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await archiveLynxSessions(runtimeFetch as never, [
      { sessionId: 'ses_1', directory: '/repo' },
      { sessionId: 'ses_fail', directory: '/repo' },
      { sessionId: 'ses_1', directory: '/dup' },
    ], { archivedAt: 99 });
    expect(result).toEqual({ archivedIds: ['ses_1'], failedIds: ['ses_fail'] });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ time: { archived: 99 } });
    expect(await archiveLynxSessions(null, [{ sessionId: 'ses_1' }])).toEqual({
      archivedIds: [],
      failedIds: ['ses_1'],
    });
  });

  test('deleteLynxSession treats 404 as ok (parent cascade)', async () => {
    const result = await deleteLynxSession(
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      { sessionId: 'ses_child', directory: '/repo' },
    );
    expect(result).toEqual({ status: 'ok' });
  });
});
