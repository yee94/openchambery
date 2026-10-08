import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCode } from '@opencode/client';
import { configureOpenCodeCredentials, getProviderAuth, removeProviderAuth } from './opencodeAuth';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

afterEach(() => { configureOpenCodeCredentials(null); vi.unstubAllGlobals(); });

describe('extension host credentials', () => {
  it('reads active credentials and deletes through the selected service SDK', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ data: [{ id: 'credential_1', integrationID: 'openai', label: 'account', active: true, value: { type: 'key', key: 'test-key' } }] });
    }));
    configureOpenCodeCredentials(() => OpenCode.make({ baseUrl: 'http://service.invalid' }));
    await expect(getProviderAuth('openai')).resolves.toEqual({ type: 'api', key: 'test-key' });
    await expect(removeProviderAuth('openai')).resolves.toBe(true);
    expect(calls).toEqual(['GET /api/credential', 'GET /api/credential', 'DELETE /api/credential/credential_1']);
  });
  it.each(['/credential', '/api/credential/', '/api/%63redential'])('keeps %s out of the webview', async (path) => {
    const response = await handleProxyBridgeMessage({ id: 'request', type: 'api:proxy', payload: { method: 'GET', path } }, undefined, {
      tryHandleLocalFsProxy: vi.fn(async () => null),
      buildUnavailableApiResponse: vi.fn(() => ({ status: 503, headers: {}, bodyText: '' })),
      sanitizeForwardHeaders: (headers) => headers || {},
      collectHeaders: () => ({}),
      base64EncodeUtf8: (text) => Buffer.from(text).toString('base64'),
    });
    expect(response?.data).toMatchObject({ status: 403 });
  });
  it('does not return logged-out success for upstream authentication failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ secret: 'private' }, { status: 401 })));
    configureOpenCodeCredentials(() => OpenCode.make({ baseUrl: 'http://service.invalid' }));
    await expect(getProviderAuth('openai')).rejects.toThrow(/^Unable to read OpenCode credentials$/);
  });
});
