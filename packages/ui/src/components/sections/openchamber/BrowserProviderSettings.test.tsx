import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dict as en } from '@/lib/i18n/messages/en';
import { queryKeys } from '@/lib/queryRuntime';
import { BrowserProviderSettings } from './BrowserProviderSettings';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: keyof typeof en) => en[key] ?? key,
  }),
}));
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'host-a',
}));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

const render = async () => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <BrowserProviderSettings />
      </QueryClientProvider>,
    );
  });
};

describe('BrowserProviderSettings', () => {
  it('does not show a connected choice when the host lists no providers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ providers: [], selectedId: 'builtin' }), { status: 200 }));
    await render();
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain('Browser provider');
    expect(host.querySelector('[aria-label="Choose which extension answers the agent\'s browser actions"]')).toBeNull();
  });

  it('lets the user select a listed provider', async () => {
    client.setQueryData(queryKeys.browserProviders.catalog('host-a'), {
      providers: [
        { id: 'ext.chrome', name: 'Chrome', surface: true },
        { id: 'ext.firefox', name: 'Firefox', surface: false },
      ],
      selectedId: 'ext.chrome',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ selectedId: 'ext.firefox' }), { status: 200 }));
    await render();
    expect(host.textContent).toContain('Chrome');
    expect(host.innerHTML).not.toContain('builtin');
    expect(host.innerHTML).not.toContain('OpenChamber Web');
    expect(host.querySelector('[aria-label="Choose which extension answers the agent\'s browser actions"]')).toBeTruthy();
  });
});
