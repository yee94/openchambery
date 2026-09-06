import { describe, expect, test } from 'vitest';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  LYNX_APPEARANCE_THEME_IDS,
  appearancePatchFromThemeChoice,
  loadLynxSettings,
  loadLynxSystemInfo,
  saveLynxSettings,
} from './api';

const fetchWith = (impl: LynxRuntimeFetch): LynxRuntimeFetch => impl;

describe('Lynx settings API', () => {
  test('load/save honor no-runtime and never invent success', async () => {
    expect(await loadLynxSettings(null)).toEqual({ status: 'no-runtime' });
    expect(await saveLynxSettings(null, { themeId: 'flexoki-light' })).toEqual({ status: 'no-runtime' });
    expect(await loadLynxSystemInfo(undefined)).toEqual({ status: 'no-runtime' });
  });

  test('GET/PUT /api/config/settings round-trip flexoki theme ids', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = fetchWith(async (path, init) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path === '/api/config/settings' && (init?.method === 'GET' || !init?.method)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lightThemeId: 'flexoki-light',
            darkThemeId: 'flexoki-dark',
            useSystemTheme: true,
          }),
        };
      }
      if (path === '/api/config/settings' && init?.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(init.body || '{}'),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const loaded = await loadLynxSettings(runtimeFetch);
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.settings.lightThemeId).toBe(LYNX_APPEARANCE_THEME_IDS.light);
    }

    const patch = appearancePatchFromThemeChoice('dark');
    const saved = await saveLynxSettings(runtimeFetch, patch);
    expect(saved.status).toBe('ok');
    expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    expect(patch.themeId).toBe('flexoki-dark');
    expect(patch.useSystemTheme).toBe(false);
  });

  test('failed GET surfaces failure (not empty settings)', async () => {
    const runtimeFetch = fetchWith(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'down' }),
    }));
    const result = await loadLynxSettings(runtimeFetch);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.httpStatus).toBe(503);
  });

  test('system info keeps Lynx client version separate from instance', async () => {
    const runtimeFetch = fetchWith(async (path) => {
      expect(path).toBe('/api/system/info');
      return {
        ok: true,
        status: 200,
        json: async () => ({ openchamberVersion: '1.19.7-beta.7' }),
      };
    });
    const result = await loadLynxSystemInfo(runtimeFetch);
    expect(result).toEqual({
      status: 'ok',
      info: { openchamberVersion: '1.19.7-beta.7' },
    });
  });
});
