import { describe, expect, test } from 'vitest';

import {
  completeLynxProviderOAuth,
  loadLynxProviderAuthMethods,
  saveLynxProviderApiKey,
  startLynxProviderOAuth,
} from './providerAuth';

describe('providerAuth', () => {
  test('no-runtime is not ok', async () => {
    expect(await loadLynxProviderAuthMethods(null)).toEqual({ status: 'no-runtime' });
    expect(await saveLynxProviderApiKey(null, 'anthropic', 'sk')).toEqual({ status: 'no-runtime' });
  });

  test('loads Cap provider auth methods', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toBe('/api/provider/auth');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: {
            anthropic: [{ type: 'api', label: 'API Key' }, { type: 'oauth', label: 'OAuth', name: 'Browser' }],
          },
        }),
      };
    };
    const result = await loadLynxProviderAuthMethods(runtimeFetch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.byProvider.anthropic).toEqual([
      { type: 'api', label: 'API Key', index: 0 },
      { type: 'oauth', label: 'OAuth', index: 1 },
    ]);
  });

  test('saves API key via PUT /api/auth/:id', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await saveLynxProviderApiKey(runtimeFetch, 'anthropic', 'sk-test');
    expect(result).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({ path: '/api/auth/anthropic', method: 'PUT' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'api', key: 'sk-test' });
  });

  test('oauth authorize returns host-only steps without inventing browser', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toContain('/oauth/authorize');
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://example.com/oauth', method: 'code', user_code: 'ABCD' }),
      };
    };
    const result = await startLynxProviderOAuth(runtimeFetch, 'github-copilot', 0);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.url).toBe('https://example.com/oauth');
    expect(result.userCode).toBe('ABCD');
    expect(result.hostOnlySteps.length).toBeGreaterThan(0);
  });

  test('oauth callback posts Cap route', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    expect(await completeLynxProviderOAuth(runtimeFetch, 'github-copilot', 0, 'code')).toEqual({
      status: 'ok',
    });
    expect(calls[0]?.path).toContain('/api/provider/github-copilot/oauth/callback');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ method: 0, code: 'code' });
  });
});
