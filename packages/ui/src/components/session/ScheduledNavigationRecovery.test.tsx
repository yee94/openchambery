import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn(), client: null as QueryClient | null }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return state.client; } }));
import { ScheduledNavigationActivity } from './SidebarNavigationActivity';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  state.client?.clear();
  vi.restoreAllMocks();
});

test.each(['visibility', 'pageshow', 'resume', 'combined'] as const)('%s repairs the running badge after a missed completion even with a fresh heartbeat', async (trigger) => {
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } });
  let status = 'running';
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const encoder = new TextEncoder();
  state.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/openchamber/events') {
      signals.push(init!.signal as AbortSignal);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(encoder.encode('data: {"type":"openchamber:event-stream-ready"}\n\n'));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ tasks: [{ projectId: 'project', task: { id: 'task', state: { lastStatus: status } } }], failedProjectIds: [] });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={state.client!}><ScheduledNavigationActivity /></QueryClientProvider>));
  await flush();
  expect(host.querySelector('svg.animate-spin')).not.toBeNull();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  status = 'success';
  streams[0].enqueue(encoder.encode('data: {"type":"openchamber:heartbeat"}\n\n'));
  await flush();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => {
    if (trigger === 'visibility' || trigger === 'combined') document.dispatchEvent(new Event('visibilitychange'));
    if (trigger === 'pageshow' || trigger === 'combined') window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    if (trigger === 'resume' || trigger === 'combined') window.dispatchEvent(new Event('openchamber:system-resume'));
  });
  await flush();
  expect(host.querySelector('svg.animate-spin')).toBeNull();
  expect(signals[0].aborted).toBe(true);
  expect(streams).toHaveLength(2);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await flush();
  // A second visible notification alone cannot cause a reconnect loop.
  const count = streams.length;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await flush();
  expect(streams).toHaveLength(count);
  await act(async () => root!.unmount());
  root = undefined;
  window.dispatchEvent(new Event('openchamber:system-resume'));
  await flush();
  expect(streams).toHaveLength(count);
  expect(signals.at(-1)?.aborted).toBe(true);
  streams.forEach((stream) => stream.close());
});
