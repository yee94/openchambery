import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  fetch: vi.fn(), toastError: vi.fn(), client: null as QueryClient | null,
  listener: null as ((event: { type: string }) => void) | null,
  view: 'tasks',
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({
  get queryClient() { return state.client; },
  queryKeys: { runtime: () => ['relay:test'] },
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: typeof state.listener) => {
  state.listener = listener;
  return () => { state.listener = null; };
} }));
vi.mock('@/components/ui', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('./ScheduledTaskEditorDialog', () => ({ ScheduledTaskEditorDialog: () => null }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: vi.fn() }));
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }));
vi.mock('@/lib/router', () => ({ parseRoute: () => ({ scheduleView: state.view }), updateBrowserURL: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en' }));
vi.mock('@/stores/useProjectsStore', () => {
  const store = { projects: [], getActiveProject: () => null };
  return { useProjectsStore: (select: (value: typeof store) => unknown) => select(store) };
});
vi.mock('@/stores/useUIStore', () => {
  const store = { isMobile: false, setMainTabGuard: vi.fn() };
  return { useUIStore: Object.assign((select: (value: typeof store) => unknown) => select(store), { getState: () => store }) };
});
import { ScheduledTasksWorkspace } from './ScheduledTasksDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  state.client?.clear();
  vi.clearAllMocks();
});

test.each(['tasks', 'history'])('%s: relay reset during refresh stays silent and stream-ready recovers the cached snapshot', async (view) => {
  state.view = view;
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const snapshot = { tasks: [{ projectId: 'project', task: {
    id: 'task', name: 'Cached scheduled task', enabled: true,
    schedule: { kind: 'daily', time: '09:00' },
    execution: { prompt: 'test', providerID: 'provider', modelID: 'model' },
    state: { createdAt: 1, updatedAt: 1, lastStatus: 'success' },
  } }], failedProjectIds: [] };
  const respond = async (path: string) => Response.json(path.includes('/runs')
    ? { runs: [], nextCursor: null, complete: true }
    : snapshot);
  state.fetch.mockImplementation(respond);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={state.client!}><ScheduledTasksWorkspace /></QueryClientProvider>));
  await flush();
  const key = ['relay:test', 'scheduled-tasks'];
  expect(state.client.getQueryData(key)).toEqual(snapshot);

  const reset = new Error('relay tunnel reset: relay socket closed (code 1006)');
  state.fetch.mockRejectedValue(reset);
  await act(async () => { await state.client!.invalidateQueries({ queryKey: key }); });
  await flush();
  expect(state.client.getQueryState(key)?.error).toBe(reset);
  expect(state.client.getQueryData(key)).toEqual(snapshot);
  expect(state.toastError).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain(reset.message);
  if (view === 'tasks') expect(host.textContent).toContain('Cached scheduled task');

  state.fetch.mockImplementation(respond);
  await act(async () => {
    state.listener?.({ type: 'event-stream-ready' });
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  await flush();
  expect(state.client.getQueryState(key)?.status).toBe('success');
  expect(state.toastError).not.toHaveBeenCalled();
});

test('an initial load failure remains visible inline', async () => {
  state.view = 'tasks';
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  state.fetch.mockRejectedValue(new Error('Permission denied'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={state.client!}><ScheduledTasksWorkspace /></QueryClientProvider>));
  await flush();
  expect(host.textContent).toContain('Permission denied');
  expect(state.client.getQueryData(['relay:test', 'scheduled-tasks'])).toBeUndefined();
});
