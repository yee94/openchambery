import { describe, expect, test } from 'vitest';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  catalogLoaderForSlug,
  loadAgentsCatalog,
  loadProvidersCatalog,
  loadUsageRows,
} from './catalogs';

describe('Lynx settings catalogs', () => {
  test('no-runtime never returns empty ok', async () => {
    expect(await loadProvidersCatalog(null)).toEqual({ status: 'no-runtime' });
    expect(await loadAgentsCatalog(undefined)).toEqual({ status: 'no-runtime' });
    expect(await loadUsageRows(null)).toEqual({ status: 'no-runtime' });
  });

  test('providers failure ≠ empty list', async () => {
    const runtimeFetch: LynxRuntimeFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const result = await loadProvidersCatalog(runtimeFetch);
    expect(result.status).toBe('failed');
  });

  test('providers ok parses Cap catalog shape', async () => {
    const runtimeFetch: LynxRuntimeFetch = async (path) => {
      expect(path).toBe('/api/config/catalog/providers');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: [
            { id: 'openai', name: 'OpenAI' },
            { id: 'anthropic', name: 'Anthropic' },
          ],
        }),
      };
    };
    const result = await loadProvidersCatalog(runtimeFetch);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.items.map((item) => item.id)).toEqual(['openai', 'anthropic']);
    }
  });

  test('usage keeps per-provider failure on that row', async () => {
    const runtimeFetch: LynxRuntimeFetch = async (path) => {
      if (path.includes('openai')) {
        return { ok: true, status: 200, json: async () => ({ displayName: 'OpenAI', status: 'ok' }) };
      }
      return { ok: false, status: 502, json: async () => ({}) };
    };
    const result = await loadUsageRows(runtimeFetch, ['openai', 'anthropic']);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rows[0]?.status).toBe('ok');
      expect(result.rows[1]?.status).toBe('failed');
      expect(result.rows[1]?.error).toContain('502');
    }
  });

  test('slug → loader map covers catalog pages', () => {
    for (const slug of [
      'providers', 'agents', 'mcp', 'plugins', 'skills.installed',
      'commands', 'magic-prompts', 'snippets',
    ]) {
      expect(catalogLoaderForSlug(slug)).toBeTypeOf('function');
    }
    expect(catalogLoaderForSlug('appearance')).toBeNull();
  });
});
