import { describe, expect, test } from 'vitest';

import {
  archiveLynxSession,
  createLynxSession,
  deleteLynxSession,
  renameLynxSession,
  toggleLynxSessionPin,
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
