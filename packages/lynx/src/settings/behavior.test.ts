import { describe, expect, test } from 'vitest';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  loadLynxAgentsMd,
  loadLynxSmallModelCapabilities,
  sanitizeLynxResponseStylePreset,
  saveLynxAgentsMd,
} from './behavior';

const fetchWith = (impl: LynxRuntimeFetch): LynxRuntimeFetch => impl;

describe('Lynx behavior / summary APIs', () => {
  test('agents-md and small-model honor no-runtime', async () => {
    expect(await loadLynxAgentsMd(null)).toEqual({ status: 'no-runtime' });
    expect(await saveLynxAgentsMd(null, 'x')).toEqual({ status: 'no-runtime' });
    expect(await loadLynxSmallModelCapabilities(undefined)).toEqual({ status: 'no-runtime' });
  });

  test('GET/PUT /api/behavior/agents-md round-trip', async () => {
    const runtimeFetch = fetchWith(async (path, init) => {
      if (path === '/api/behavior/agents-md' && (init?.method === 'GET' || !init?.method)) {
        return { ok: true, status: 200, json: async () => ({ content: 'Be helpful\n', exists: true }) };
      }
      if (path === '/api/behavior/agents-md' && init?.method === 'PUT') {
        const body = JSON.parse(init.body || '{}') as { content?: string };
        expect(body.content?.endsWith('\n')).toBe(true);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const loaded = await loadLynxAgentsMd(runtimeFetch);
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') expect(loaded.content).toContain('Be helpful');
    expect(await saveLynxAgentsMd(runtimeFetch, 'Be concise')).toEqual({ status: 'ok' });
  });

  test('agents-md GET failure ≠ empty success', async () => {
    const result = await loadLynxAgentsMd(fetchWith(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'down' }),
    })));
    expect(result.status).toBe('failed');
  });

  test('small-model callableModels empty is empty, not fake ok list', async () => {
    const empty = await loadLynxSmallModelCapabilities(fetchWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ callableModels: {} }),
    })));
    expect(empty.status).toBe('empty');

    const failed = await loadLynxSmallModelCapabilities(fetchWith(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })));
    expect(failed.status).toBe('failed');
  });

  test('sanitize response style presets', () => {
    expect(sanitizeLynxResponseStylePreset('mentor')).toBe('mentor');
    expect(sanitizeLynxResponseStylePreset('custom')).toBe('custom');
    expect(sanitizeLynxResponseStylePreset('nope')).toBe('concise');
  });
});
