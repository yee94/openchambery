import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOpenCodeCredentials, getProviderAuth, readOpenCodeCredentials, removeProviderAuth, openCodeCredentialSource } from './auth.js';

const key = (id, active, value = id) => ({ id, integrationID: 'openai', label: id, active, value: { type: 'key', key: value } });
afterEach(() => { configureOpenCodeCredentials(null); vi.unstubAllGlobals(); });

describe('authoritative host credential API', () => {
  it('observes active account switching and logout without cached or legacy fallback', async () => {
    let entries = [key('old', true), key('new', false)];
    configureOpenCodeCredentials(() => ({ credential: { list: async () => entries } }));
    await expect(getProviderAuth('openai')).resolves.toEqual({ type: 'api', key: 'old' });
    entries = [key('old', false), key('new', true)];
    await expect(getProviderAuth('openai')).resolves.toEqual({ type: 'api', key: 'new' });
    entries = [];
    await expect(getProviderAuth('openai')).resolves.toBeNull();
  });
  it('maps OAuth metadata without copying arbitrary secret-bearing fields', async () => {
    configureOpenCodeCredentials(() => ({ credential: { list: async () => [{ ...key('a', true), value: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, metadata: { accountID: 'account', enterpriseUrl: 'https://example.com', unrelated: 'private' } } }] } }));
    await expect(readOpenCodeCredentials()).resolves.toEqual({ openai: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, accountId: 'account', enterpriseUrl: 'https://example.com' } });
  });
  it.each([null, {}, { data: [] }, [{ ...key('a', true), value: { type: 'unknown' } }], [key('a', true), key('b', true)]])('rejects unsupported payloads without inventing empty success', async (entries) => {
    configureOpenCodeCredentials(() => ({ credential: { list: async () => entries } }));
    await expect(readOpenCodeCredentials()).rejects.toThrow('Unable to read OpenCode credentials');
  });
  it('redacts transport/auth failures and leaves them retryable', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('Authorization: private-token')).mockResolvedValueOnce([]);
    configureOpenCodeCredentials(() => ({ credential: { list } }));
    await expect(readOpenCodeCredentials()).rejects.toThrow(/^Unable to read OpenCode credentials$/);
    await expect(readOpenCodeCredentials()).resolves.toEqual({});
  });
  it('removes all provider accounts, preserves other integrations and supports retry after partial failure', async () => {
    let entries = [key('old', false), key('new', true), { ...key('other', true), integrationID: 'anthropic' }];
    const remove = vi.fn(async ({ credentialID }) => { entries = entries.filter((e) => e.id !== credentialID); });
    configureOpenCodeCredentials(() => ({ credential: { list: async () => entries, remove } }));
    remove.mockImplementationOnce(async ({ credentialID }) => { entries = entries.filter((e) => e.id !== credentialID); });
    remove.mockRejectedValueOnce(new Error('private-token'));
    await expect(removeProviderAuth('openai')).rejects.toThrow('some accounts may already have been removed');
    await expect(removeProviderAuth('openai')).resolves.toBe(true);
    expect(entries.map((e) => e.id)).toEqual(['other']);
    await expect(removeProviderAuth('openai')).resolves.toBe(false);
  });
  it('uses the current endpoint/auth through the real SDK for every read', async () => {
    let origin = 'http://first.invalid';
    let authorization = 'Basic first';
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const req = new Request(input, init);
      requests.push([req.url, req.headers.get('authorization')]);
      return Response.json({ data: [key('current', true)] });
    }));
    configureOpenCodeCredentials(openCodeCredentialSource({ buildOpenCodeUrl: () => origin, getOpenCodeAuthHeaders: () => ({ Authorization: authorization }) }));
    await readOpenCodeCredentials();
    origin = 'http://second.invalid'; authorization = 'Basic second';
    await readOpenCodeCredentials();
    expect(requests).toEqual([['http://first.invalid/api/credential', 'Basic first'], ['http://second.invalid/api/credential', 'Basic second']]);
  });
});
