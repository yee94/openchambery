import { describe, expect, it, vi } from 'vitest';
import {
  classifyCustomSummaryApiFailure,
  listCustomSummaryModels,
  parseCustomApiBaseURL,
  testCustomSummaryApi,
} from './custom-api.js';

describe('parseCustomApiBaseURL', () => {
  it('accepts http(s) URLs and strips trailing slashes', () => {
    expect(parseCustomApiBaseURL('https://api.example.test/v1/')).toBe('https://api.example.test/v1');
    expect(parseCustomApiBaseURL('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
  });

  it('rejects non-http URLs and embedded credentials', () => {
    expect(parseCustomApiBaseURL('ftp://api.example.test')).toBeNull();
    expect(parseCustomApiBaseURL('https://user:pass@api.example.test/v1')).toBeNull();
    expect(parseCustomApiBaseURL('not a url')).toBeNull();
  });
});

describe('classifyCustomSummaryApiFailure', () => {
  it('maps 401/403 to token and 404/model_not_found to model', () => {
    expect(classifyCustomSummaryApiFailure({ status: 401 })).toBe('token');
    expect(classifyCustomSummaryApiFailure({ status: 403 })).toBe('token');
    expect(classifyCustomSummaryApiFailure({ status: 404 })).toBe('model');
    expect(classifyCustomSummaryApiFailure({
      status: 400,
      bodyText: '{"error":{"code":"model_not_found"}}',
    })).toBe('model');
  });

  it('maps network and non-OpenAI-compatible failures to baseURL', () => {
    expect(classifyCustomSummaryApiFailure({ cause: { code: 'ENOTFOUND' } })).toBe('baseURL');
    expect(classifyCustomSummaryApiFailure({ cause: { name: 'AbortError' } })).toBe('baseURL');
    expect(classifyCustomSummaryApiFailure({ status: 502, bodyText: '<html>bad gateway</html>' })).toBe('baseURL');
  });
});

describe('testCustomSummaryApi', () => {
  it('returns incomplete when any of the custom triple is missing', async () => {
    expect(await testCustomSummaryApi({
      baseURL: 'https://api.example.test/v1',
      modelID: 'gpt-4.1-mini',
    })).toEqual({ ok: false, code: 'incomplete' });
  });

  it('classifies HTTP failures from the probe request', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    expect(await testCustomSummaryApi({
      baseURL: 'https://api.example.test/v1',
      modelID: 'gpt-4.1-mini',
      apiToken: 'sk-test',
      fetchImpl,
    })).toEqual({ ok: false, code: 'token' });
  });

  it('accepts an OpenAI-compatible chat completion payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await testCustomSummaryApi({
      baseURL: 'https://api.example.test/v1',
      modelID: 'gpt-4.1-mini',
      apiToken: 'sk-test',
      fetchImpl,
    })).toEqual({ ok: true });
  });

  it('treats a 200 HTML body as a baseURL failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not openai</html>', { status: 200 }));
    expect(await testCustomSummaryApi({
      baseURL: 'https://api.example.test/v1',
      modelID: 'gpt-4.1-mini',
      apiToken: 'sk-test',
      fetchImpl,
    })).toEqual({ ok: false, code: 'baseURL' });
  });
});

describe('listCustomSummaryModels', () => {
  it('returns unique model ids from an OpenAI-compatible /models payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1-nano' }, { id: 'gpt-4.1-mini' }],
    }), { status: 200 }));
    expect(await listCustomSummaryModels({
      baseURL: 'https://api.example.test/v1',
      apiToken: 'sk-test',
      fetchImpl,
    })).toEqual(['gpt-4.1-mini', 'gpt-4.1-nano']);
  });

  it('degrades to an empty list when /models is unavailable', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); });
    expect(await listCustomSummaryModels({
      baseURL: 'https://api.example.test/v1',
      apiToken: 'sk-test',
      fetchImpl,
    })).toEqual([]);
  });
});
