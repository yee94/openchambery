import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PROVIDER_CATALOG_PATH, BROWSER_PROVIDER_SELECTION_PATH } from '@/lib/browser-provider/contract';
import { queryKeys } from '@/lib/queryRuntime';

const fetchMock = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({ current: 'host-a' }));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => transport.current,
}));

import {
  BrowserProviderRequestError,
  fetchBrowserProviderCatalog,
  selectBrowserProvider,
} from './browserProviderQueries';

const catalog = {
  providers: [{ id: 'ext.chrome', name: 'Chrome', surface: true }],
  selectedId: null,
};

afterEach(() => {
  fetchMock.mockReset();
  transport.current = 'host-a';
});

describe('browser provider queries', () => {
  it('returns a listed catalog and does not turn failure into an empty connected browser', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }));
    await expect(fetchBrowserProviderCatalog()).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith(BROWSER_PROVIDER_CATALOG_PATH, expect.objectContaining({ method: 'GET' }));

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(fetchBrowserProviderCatalog()).rejects.toBeInstanceOf(BrowserProviderRequestError);

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(fetchBrowserProviderCatalog()).rejects.toMatchObject({ status: 500 });
  });

  it('selects a listed provider and rolls the cache back when the host refuses', async () => {
    const client = new QueryClient();
    const key = queryKeys.browserProviders.catalog('host-a');
    client.setQueryData(key, catalog);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ selectedId: 'ext.chrome' }), { status: 200 }));

    await expect(selectBrowserProvider('ext.chrome', client)).resolves.toEqual({
      providers: catalog.providers,
      selectedId: 'ext.chrome',
    });
    expect(fetchMock).toHaveBeenCalledWith(BROWSER_PROVIDER_SELECTION_PATH, expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ id: 'ext.chrome' }),
    }));

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(selectBrowserProvider('ext.chrome', client)).rejects.toMatchObject({ status: 404 });
    expect(client.getQueryData(key)).toEqual(catalog);
  });

  it('does not keep a selection whose provider is not listed', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.browserProviders.catalog('host-a'), { providers: [], selectedId: null });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ selectedId: 'ext.chrome' }), { status: 200 }));
    await expect(selectBrowserProvider('ext.chrome', client)).rejects.toMatchObject({ status: 409 });
  });
});
