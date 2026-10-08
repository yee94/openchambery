import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  transport: 'navigation-a',
  fetch: vi.fn(),
  client: null as QueryClient | null,
  listeners: new Set<(event: { type: string }) => void>(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport,
  getRuntimeGeneration: () => 1,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return state.client; } }));
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: { type: string }) => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
import { AssistantNavigationActivity, ScheduledNavigationActivity } from './SidebarNavigationActivity';
import { assistantQueryKeys } from '@/queries/assistantQueries';
import { parseAssistantDTO, type AssistantSnapshotDTO } from '@/queries/assistantDTO';
// @ts-expect-error Shared server contract fixtures are JavaScript.
import { assistantContractFixtures } from '../../../../web/server/lib/assistants/contracts.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const snapshot = (status: string) => ({ tasks: [{ projectId: 'project', task: { id: 'task', state: { lastStatus: status } } }], failedProjectIds: [] });
const render = async () => {
  await act(async () => root.render(<QueryClientProvider client={state.client!}><ScheduledNavigationActivity /></QueryClientProvider>));
};
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
beforeEach(() => {
  state.transport = 'navigation-a';
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  state.fetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  state.client?.clear();
  state.listeners.clear();
});

test('run start/end events update the ring without opening the schedule page', async () => {
  let status = 'idle';
  state.fetch.mockImplementation(async () => Response.json(snapshot(status)));
  await render(); await flush();
  expect(host.querySelector('svg')).toBeNull();
  status = 'running';
  await act(async () => { state.listeners.forEach((listener) => listener({ type: 'scheduled-task-ran' })); });
  await flush();
  expect(host.querySelector('svg.animate-spin')).not.toBeNull();
  status = 'success';
  await act(async () => { state.listeners.forEach((listener) => listener({ type: 'scheduled-task-ran' })); });
  await flush();
  expect(host.querySelector('svg')).toBeNull();
  expect(state.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

test('failed refresh preserves running state; switching runtime does not reuse it', async () => {
  state.fetch.mockImplementation(async () => Response.json(snapshot('running')));
  await render(); await flush();
  expect(host.querySelector('svg')).not.toBeNull();
  state.fetch.mockImplementation(async () => Response.json({}, { status: 503 }));
  await act(async () => { state.listeners.forEach((listener) => listener({ type: 'event-stream-ready' })); });
  await flush();
  expect(host.querySelector('svg')).not.toBeNull();
  state.transport = 'navigation-b';
  state.fetch.mockImplementation(async () => Response.json(snapshot('idle')));
  await render(); await flush();
  expect(host.querySelector('svg')).toBeNull();
  expect(state.listeners.size).toBe(1);
});

test('assistant ring follows authoritative working state independently of unread messages', async () => {
  const key = assistantQueryKeys.snapshot(state.transport);
  const assistant = parseAssistantDTO({ ...assistantContractFixtures.assistant, working: true, unreadCount: 3 });
  const snapshot: AssistantSnapshotDTO = { revision: 1, enabled: true, assistants: [assistant] };
  state.client!.setQueryData(key, snapshot);
  state.fetch.mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<QueryClientProvider client={state.client!}><AssistantNavigationActivity /></QueryClientProvider>));
  expect(host.querySelector('svg.animate-spin')).not.toBeNull();
  await act(async () => {
    state.client!.setQueryData(key, { ...snapshot, assistants: [{ ...assistant, working: false, activeContactTurn: null }] });
  });
  await flush();
  expect(host.querySelector('svg')).toBeNull();
  expect(state.listeners.size).toBe(1);
});
