import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { resetQuotaStoreForRuntimeSwitch, useQuotaStore } from './useQuotaStore';
import type { ProviderResult } from '@/types';

const directory = vi.hoisted(() => ({ currentDirectory: '/project-a' }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign(() => directory.currentDirectory, { getState: () => directory }) }));
const quota = (sourceId: string, provider = 'claude'): ProviderResult => ({
  providerId: `magpie:${sourceId}:${provider}`, providerName: provider, source: 'magpie', sourceId,
  ok: true, configured: true, fetchedAt: 1, usage: { windows: {} },
});
const source = (id: string, results = [quota(id)]) => ({ id, name: id, results });
const respond = (sources: ReturnType<typeof source>[]) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources })));

beforeEach(() => {
  resetQuotaStoreForRuntimeSwitch(); queryClient.clear();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://quota.test' });
  directory.currentDirectory = '/project-a';
  useQuotaStore.setState({ magpieUsageUrl: '', magpieHiddenProviders: [], dropdownProviderIds: ['claude'] });
});
afterEach(() => vi.unstubAllGlobals());

describe('dynamic Magpie quota lifecycle', () => {
  it('keeps previously discovered sources when only local discovery succeeds', async () => {
    respond([source('remote')]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: [source('local')], incomplete: true })));
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results.map((r) => r.providerId)).toEqual(['magpie:remote:claude', 'magpie:local:claude']);
    expect(useQuotaStore.getState().results[0].error).toBe('Magpie discovery is incomplete');
    respond([source('local')]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results.map((r) => r.providerId)).toEqual(['magpie:local:claude']);
  });
  it('discovers separate providers and preserves built-in data and hidden selections', async () => {
    const builtin: ProviderResult = { ...quota('a'), source: undefined, sourceId: undefined, providerId: 'claude' };
    useQuotaStore.setState({ results: [builtin], magpieHiddenProviders: ['magpie:a:claude'] });
    respond([source('a', [quota('a'), quota('a', 'codex')])]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results).toEqual([builtin, quota('a'), quota('a', 'codex')]);
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude', 'magpie:a:codex']);
  });
  it('keeps failed source readings while replacing unrelated complete sources; successful empty removes them', async () => {
    respond([source('a'), source('b')]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    respond([{ ...source('a', []), error: 'offline' } as ReturnType<typeof source>, source('b', [])]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results).toEqual([{ ...quota('a'), ok: false, error: 'offline' }]);
    respond([]);
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results).toEqual([]);
  });
  it('keeps the snapshot on transport/schema failure', async () => {
    respond([source('a')]); await useQuotaStore.getState().fetchMagpieQuotas();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: null })));
    await useQuotaStore.getState().fetchMagpieQuotas();
    expect(useQuotaStore.getState().results).toEqual([quota('a')]);
    expect(useQuotaStore.getState().magpieError).toBeTruthy();
  });
  it('deduplicates concurrent reads and carries the current directory', async () => {
    const fetch = vi.fn(async (input: string) => {
      expect(String(input)).toContain('directory=%2Fproject-a');
      return Response.json({ sources: [source('a')] });
    });
    vi.stubGlobal('fetch', fetch);
    await Promise.all([useQuotaStore.getState().fetchMagpieQuotas(), useQuotaStore.getState().fetchMagpieQuotas()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useQuotaStore.getState().results).toHaveLength(1);
  });
  it('rejects completions from a previous runtime and directory', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = useQuotaStore.getState().fetchMagpieQuotas();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    resetQuotaStoreForRuntimeSwitch();
    finish(Response.json({ sources: [source('old')] })); await pending;
    expect(useQuotaStore.getState().results).toEqual([]);
    queryClient.clear();
    finish = undefined as unknown as typeof finish;
    const next = useQuotaStore.getState().fetchMagpieQuotas();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    directory.currentDirectory = '/project-b';
    finish(Response.json({ sources: [source('wrong-directory')] })); await next;
    expect(useQuotaStore.getState().results).toEqual([]);
  });
});
