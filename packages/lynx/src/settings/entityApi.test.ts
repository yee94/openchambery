import { describe, expect, test } from 'vitest';

import {
  deleteLynxEntity,
  loadLynxEntityDetail,
  saveLynxEntity,
  type LynxEntityDetail,
} from './entityApi';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('Lynx entity API', () => {
  test('no-runtime never returns empty ok detail', async () => {
    const result = await loadLynxEntityDetail(null, 'snippets', 'foo');
    expect(result).toEqual({ status: 'no-runtime' });
  });

  test('snippets detail + save/delete hit Cap routes', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method });
      if (path.startsWith('/api/config/snippets/foo') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(200, { name: 'foo', content: 'hello', description: 'd' });
      }
      if (init?.method === 'PATCH') return jsonResponse(200, { ok: true });
      if (init?.method === 'DELETE') return jsonResponse(200, { ok: true });
      return jsonResponse(500, { error: 'unexpected' });
    };

    const loaded = await loadLynxEntityDetail(runtimeFetch, 'snippets', 'foo');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    const saved = await saveLynxEntity(runtimeFetch, loaded.detail, { content: 'world', description: 'd2' });
    expect(saved).toEqual({ status: 'ok' });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(true);

    const deleted = await deleteLynxEntity(runtimeFetch, loaded.detail);
    expect(deleted).toEqual({ status: 'ok' });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  test('providers save is unsupported; delete clears auth', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('/source')) return jsonResponse(200, { sources: [] });
      if (path.includes('/auth')) return jsonResponse(200, { ok: true });
      return jsonResponse(500, { error: 'no' });
    };
    const loaded = await loadLynxEntityDetail(runtimeFetch, 'providers', 'anthropic', {
      listItem: { id: 'anthropic', title: 'Anthropic' },
    });
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    const saved = await saveLynxEntity(runtimeFetch, loaded.detail, { title: 'x' });
    expect(saved.status).toBe('unsupported');
    const deleted = await deleteLynxEntity(runtimeFetch, loaded.detail);
    expect(deleted).toEqual({ status: 'ok' });
    expect(calls.some((call) => call.startsWith('DELETE /api/provider/anthropic/auth'))).toBe(true);
  });

  test('HTTP failure on save is failed not ok', async () => {
    const detail: LynxEntityDetail = {
      kind: 'mcp',
      id: 'server-a',
      title: 'server-a',
      fields: { name: 'server-a', description: '' },
      meta: {},
    };
    const runtimeFetch = async () => jsonResponse(500, { error: 'boom' });
    const result = await saveLynxEntity(runtimeFetch, detail, { description: 'x' });
    expect(result.status).toBe('failed');
  });

  test('projects save patches settings blob', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path === '/api/config/settings' && (!init?.method || init.method === 'GET')) {
        return jsonResponse(200, {
          projects: [{ id: 'p1', name: 'Demo', path: '/tmp/demo' }],
        });
      }
      if (path === '/api/config/settings' && init?.method === 'PUT') {
        return jsonResponse(200, JSON.parse(init.body || '{}'));
      }
      return jsonResponse(500, {});
    };
    const loaded = await loadLynxEntityDetail(runtimeFetch, 'projects', 'p1');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    const saved = await saveLynxEntity(runtimeFetch, loaded.detail, { name: 'Renamed', path: '/tmp/demo' });
    expect(saved.status).toBe('ok');
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toContain('Renamed');
  });
});
