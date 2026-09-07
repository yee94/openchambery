import { describe, expect, test } from 'vitest';

import {
  archiveLynxSession,
  copyLynxText,
  createLynxSession,
  deleteLynxSession,
  fetchLynxSessionShareUrl,
  renameLynxSession,
  shareLynxSession,
  toggleLynxSessionPin,
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
