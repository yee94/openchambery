import { describe, expect, test } from 'vitest';

import {
  createLynxGitIdentity,
  deleteLynxGitIdentity,
  loadLynxGitIdentities,
  updateLynxGitIdentity,
} from './gitIdentities';

describe('Lynx git identities (Cap GitIdentity*)', () => {
  test('no-runtime ≠ empty ok', async () => {
    expect(await loadLynxGitIdentities(null)).toEqual({ status: 'no-runtime' });
    expect(await createLynxGitIdentity(null, {
      name: 'a', userName: 'a', userEmail: 'a@b.c',
    })).toEqual({ status: 'no-runtime' });
  });

  test('HTTP failure ≠ empty profiles', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await loadLynxGitIdentities(runtimeFetch);
    expect(result.status).toBe('failed');
  });

  test('parses Cap identities list + optional global', async () => {
    const runtimeFetch = async (path: string) => {
      if (path.includes('global-identity')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ userName: 'sys', userEmail: 'sys@ex.com' }),
        };
      }
      expect(path).toContain('/api/git/identities');
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'p1', name: 'Work', userName: 'w', userEmail: 'w@ex.com', authType: 'ssh' },
        ]),
      };
    };
    const result = await loadLynxGitIdentities(runtimeFetch);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.profiles).toEqual([
        {
          id: 'p1',
          name: 'Work',
          userName: 'w',
          userEmail: 'w@ex.com',
          authType: 'ssh',
          sshKey: null,
          signCommits: undefined,
          signingKey: null,
          host: null,
        },
      ]);
      expect(result.global?.id).toBe('global');
      expect(result.global?.userEmail).toBe('sys@ex.com');
    }
  });

  test('create/update/delete hit Cap routes; global protected', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method });
      return {
        ok: true,
        status: 200,
        json: async () => (init?.body ? JSON.parse(init.body) : {}),
      };
    };
    expect(await createLynxGitIdentity(runtimeFetch, {
      name: 'n', userName: 'u', userEmail: 'e@x.com',
    })).toMatchObject({ status: 'ok' });
    expect(calls.some((c) => c.path === '/api/git/identities' && c.method === 'POST')).toBe(true);
    expect(await updateLynxGitIdentity(runtimeFetch, 'p1', { name: 'n2' })).toMatchObject({ status: 'ok' });
    expect(calls.some((c) => c.path === '/api/git/identities/p1' && c.method === 'PUT')).toBe(true);
    expect(await deleteLynxGitIdentity(runtimeFetch, 'p1')).toEqual({ status: 'ok' });
    expect((await updateLynxGitIdentity(runtimeFetch, 'global', { name: 'x' })).status).toBe('failed');
    expect((await deleteLynxGitIdentity(runtimeFetch, 'global')).status).toBe('failed');
  });
});
