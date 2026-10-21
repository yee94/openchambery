import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { AssistantContactStatus } from './AssistantContactStatus';
import { useAssistantContactWorkingStore } from './assistantWorking';

const queryIO = vi.hoisted(() => ({ fetch: vi.fn(), runtime: 'runtime', listeners: new Set<() => void>() }));
vi.mock('@/queries/assistantQueries', () => ({
  assistantContactQueryOptions: (id: string, transport: string) => ({ queryKey: [transport, 'contact', id], queryFn: queryIO.fetch }),
}));
vi.mock('@/components/chat/imageSource', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useRuntimeTransportIdentity: () => useSyncExternalStore((listener) => {
    queryIO.listeners.add(listener);
    return () => { queryIO.listeners.delete(listener); };
  }, () => queryIO.runtime) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string, params?: { time: string }) => ({
      'common.date.today': '今天',
      'common.loading': '加载中…',
      'assistants.contact.loadFailed': '加载失败',
      'assistants.conversation.typing': '正在输入…',
      'assistants.conversation.neverContacted': '尚未联系',
      'assistants.conversation.lastContact': `上次联系 ${params?.time}`,
    })[key],
  }),
}));

test('unknown, failed and partial caches never claim no contact; updates and runtimes stay isolated', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  const root = createRoot(host);
  const key = ['runtime', 'contact', 'a'];
  const render = () => act(async () => root.render(<QueryClientProvider client={client}><AssistantContactStatus assistantID="a" serverWorking={false} /></QueryClientProvider>));
  try {
    await render();
    expect(host.textContent).toBe('加载中…');
    await act(async () => {
      await client.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error('offline'); } }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toBe('加载失败');
    await act(async () => {
      client.setQueryData(key, { generation: 0, messages: [], olderComplete: false, hasMessageGap: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toBe('加载中…');
    await act(async () => {
      client.setQueryData(key, { generation: 0, olderComplete: true, hasMessageGap: false, messages: [
        { createdAt: new Date(2026, 9, 17, 21, 22).getTime(), parts: [{ type: 'text', text: 'Hello' }] },
      ] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('21:22');
    await act(async () => {
      queryIO.runtime = 'other-runtime';
      queryIO.listeners.forEach((listener) => listener());
    });
    expect(host.textContent).toBe('加载中…');
    expect(queryIO.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    queryIO.runtime = 'runtime';
    client.clear();
  }
});

test('header follows live work, restores latest contact time and isolates other assistants', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const timestamp = new Date(2026, 9, 17, 21, 22).getTime();
  const client = new QueryClient();
  client.setQueryData(['runtime', 'contact', 'a'], { messages: [], generation: 0, olderComplete: true, hasMessageGap: false });
  const render = (serverWorking: boolean, lastContactAt?: number) => act(async () => {
    root.render(<QueryClientProvider client={client}><AssistantContactStatus assistantID="a" serverWorking={serverWorking} lastContactAt={lastContactAt} /></QueryClientProvider>);
  });
  try {
    await render(false);
    expect(host.textContent).toBe('尚未联系');
    await render(false, timestamp);
    expect(host.textContent).toContain('上次联系 ');
    expect(host.textContent).toContain('21:22');
    await act(async () => useAssistantContactWorkingStore.getState().setWorking('b', true));
    expect(host.textContent).toContain('上次联系 ');
    await act(async () => useAssistantContactWorkingStore.getState().setWorking('a', true));
    expect(host.textContent).toBe('正在输入…');
    await render(true, timestamp + 60000);
    await act(async () => useAssistantContactWorkingStore.getState().setWorking('a', false));
    expect(host.textContent).toBe('正在输入…');
    await render(false, timestamp + 60000);
    expect(host.textContent).toContain('21:23');
    await render(false, NaN);
    expect(host.textContent).toBe('尚未联系');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    useAssistantContactWorkingStore.setState({ workingByID: {} });
  }
});

test('legacy snapshots missing preview time use loaded messages rather than claiming no contact', async () => {
  const client = new QueryClient();
  const host = document.createElement('div');
  const root = createRoot(host);
  const timestamp = new Date(2026, 9, 17, 21, 22).getTime();
  client.setQueryData(['runtime', 'contact', 'legacy'], { generation: 0, olderComplete: true, hasMessageGap: false, messages: [
    { createdAt: timestamp, parts: [{ type: 'text', text: 'An existing conversation' }], status: 'complete' },
  ] });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AssistantContactStatus assistantID="legacy" serverWorking={false} /></QueryClientProvider>));
    expect(host.textContent).toContain('上次联系 ');
    expect(host.textContent).toContain('21:22');
    expect(host.textContent).not.toContain('尚未联系');
    expect(queryIO.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
