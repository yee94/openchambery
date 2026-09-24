import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { queryClient } from '@/lib/queryRuntime';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { resetQuotaStoreForRuntimeSwitch, useQuotaStore } from './useQuotaStore';

const originalFetch = globalThis.fetch;

const result = (providerId: QuotaProviderId): ProviderResult => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  usage: null,
  fetchedAt: 1,
});

const providerIdFromInput = (input: RequestInfo | URL): QuotaProviderId => {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
  return url.split('/').at(-1) as QuotaProviderId;
};

describe('useQuotaStore quota queries', () => {
  beforeEach(() => {
    queryClient.clear();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://quota-store.test' });
    useQuotaStore.setState({
      results: [],
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('preserves cached provider data when a provider refresh fails', async () => {
    useQuotaStore.setState({ results: [result('openai')] });
    globalThis.fetch = async () => {
      throw new Error('quota unavailable');
    };

    await useQuotaStore.getState().fetchProviderQuota('openai');

    expect(useQuotaStore.getState().results).toEqual([result('openai')]);
    expect(useQuotaStore.getState().error).toBe('quota unavailable');
  });

  test('keeps successful providers when another provider fails', async () => {
    globalThis.fetch = async (input) => {
      const providerId = providerIdFromInput(input);
      if (providerId === 'codex') throw new Error('codex unavailable');
      return new Response(JSON.stringify(result(providerId)));
    };

    await useQuotaStore.getState().fetchAllQuotas();

    const state = useQuotaStore.getState();
    expect(state.results).toHaveLength(QUOTA_PROVIDERS.length - 1);
    expect(state.results.find((entry) => entry.providerId === 'claude')).toEqual(result('claude'));
    expect(state.error).toBe('codex unavailable');
    expect(state.lastUpdated).not.toBeNull();
  });

  test('only the latest overlapping refresh updates global completion state', async () => {
    const resolvers: Array<() => void> = [];
    const originalDateNow = Date.now;
    let dateNowCalls = 0;
    globalThis.fetch = (input) => new Promise<Response>((resolve) => {
      const providerId = providerIdFromInput(input);
      resolvers.push(() => resolve(new Response(JSON.stringify(result(providerId)))));
    });
    Date.now = () => ++dateNowCalls;

    try {
      const first = useQuotaStore.getState().fetchAllQuotas();
      const second = useQuotaStore.getState().fetchAllQuotas();
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolvers.forEach((resolve) => resolve());
      await Promise.all([first, second]);

      expect(useQuotaStore.getState().isLoading).toBe(false);
      expect(useQuotaStore.getState().lastUpdated).not.toBeNull();
      expect(dateNowCalls).toBe(QUOTA_PROVIDERS.length + 1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('does not store a null quota payload that crashes providerId lookups', async () => {
    useQuotaStore.setState({ results: [result('claude')] });
    globalThis.fetch = async () => new Response('null', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await useQuotaStore.getState().fetchProviderQuota('openai');

    const results = useQuotaStore.getState().results;
    expect(results.find((entry) => entry.providerId === 'openai')).toBe(undefined);
    expect(results).toEqual([result('claude')]);
    expect(useQuotaStore.getState().error).toBeTruthy();

    useQuotaStore.setState({ results: [result('openai')], error: null });
    await useQuotaStore.getState().fetchProviderQuota('openai');
    expect(useQuotaStore.getState().results).toEqual([result('openai')]);
    expect(useQuotaStore.getState().error).toBe('Invalid quota response');
  });

  test('drops null quota entries instead of crashing the next refresh', async () => {
    useQuotaStore.setState({ results: [null as unknown as ProviderResult, result('claude')] });
    globalThis.fetch = async () => new Response(JSON.stringify(result('openai')));

    await useQuotaStore.getState().fetchProviderQuota('openai');

    const results = useQuotaStore.getState().results;
    expect(results.every((entry) => entry.providerId)).toBe(true);
    expect(results.find((entry) => entry.providerId === 'claude')).toEqual(result('claude'));
    expect(results.find((entry) => entry.providerId === 'openai')).toEqual(result('openai'));
  });

  test('clears runtime state and ignores a previous runtime completion', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = () => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });

    const request = useQuotaStore.getState().fetchProviderQuota('openai');
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetQuotaStoreForRuntimeSwitch();
    resolveRequest?.(new Response(JSON.stringify(result('openai'))));
    await request;

    expect(useQuotaStore.getState().results).toEqual([]);
    expect(useQuotaStore.getState().isLoading).toBe(false);
    expect(useQuotaStore.getState().isFetchingProvider).toEqual({});
    expect(useQuotaStore.getState().lastUpdated).toBeNull();
  });
});
