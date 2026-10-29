import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn(), client: null as QueryClient | null }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({
  get queryClient() { return state.client; },
  queryKeys: { runtime: () => ['test'] },
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: vi.fn() }));
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en' }));
vi.mock('@/stores/useProjectsStore', () => {
  const store = { projects: [], getActiveProject: () => null };
  return { useProjectsStore: (select: (value: typeof store) => unknown) => select(store) };
});
vi.mock('@/stores/useUIStore', async () => {
  const { create } = await import('zustand');
  type State = {
    isMobile: boolean;
    activeMainTab: string;
    isSettingsDialogOpen: boolean;
    settingsPage: string;
    isScheduledTasksDialogOpen: boolean;
    scheduledTaskOpenRequest: { projectId: string; taskId: string } | null;
    setActiveMainTab: (tab: string) => boolean;
    setSettingsDialogOpen: (open: boolean) => void;
    setScheduledTasksDialogOpen: (open: boolean) => void;
    setScheduledTaskOpenRequest: (target: State['scheduledTaskOpenRequest']) => void;
    setMainTabGuard: () => void;
  };
  return { useUIStore: create<State>((set) => ({
    isMobile: true, activeMainTab: 'assistant', isSettingsDialogOpen: false, settingsPage: 'home',
    isScheduledTasksDialogOpen: false, scheduledTaskOpenRequest: null,
    setActiveMainTab: (tab) => { set({ activeMainTab: tab }); return true; },
    setSettingsDialogOpen: (open) => set({ isSettingsDialogOpen: open }),
    setScheduledTasksDialogOpen: (open) => set({ isScheduledTasksDialogOpen: open }),
    setScheduledTaskOpenRequest: (target) => set({ scheduledTaskOpenRequest: target }),
    setMainTabGuard: () => {},
  })) };
});
vi.mock('./ScheduledTaskEditorDialog', () => ({
  ScheduledTaskEditorDialog: ({ task, projectID, onDirtyChange }: {
    task: { id: string; name: string } | null;
    projectID: string;
    onDirtyChange: (dirty: boolean) => void;
  }) => <div data-editor={`${projectID}:${task?.id ?? 'create'}`}>
    {task?.name}
    <button onClick={() => onDirtyChange(true)}>dirty</button>
  </div>,
}));

import { ScheduledTasksDialog, ScheduledTasksWorkspace } from './ScheduledTasksDialog';
import { AssistantScheduleCard } from '@/components/assistants/AssistantScheduleCard';
import { useUIStore } from '@/stores/useUIStore';
import { buildSchedulePath } from '@/router/pathContract';
import { openScheduledTask } from '@/lib/scheduledTaskNavigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const task = (projectId: string, id: string) => ({ projectId, task: {
  id, name: `${projectId} task`, enabled: true,
  schedule: { kind: 'daily', time: '09:00' }, execution: { prompt: 'test' }, state: { lastStatus: 'idle' },
} });
const snapshot = { tasks: [task('project/a', 'same'), task('project/b', 'same')], failedProjectIds: [] };
const path = (projectId: string) => buildSchedulePath({ scheduleProjectId: projectId, scheduleTaskId: 'same' });
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
const render = async (children: React.ReactNode) => {
  await act(async () => root.render(<QueryClientProvider client={state.client!}>{children}</QueryClientProvider>));
  await flush();
};
const navigate = async (url: string) => {
  await act(async () => {
    window.history.replaceState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await flush();
};

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  window.history.replaceState({}, '', '/assistant/example');
  useUIStore.setState({ isMobile: true, isScheduledTasksDialogOpen: false, scheduledTaskOpenRequest: null });
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  state.fetch.mockImplementation(async () => Response.json(snapshot));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.getElementById('mobile-overlay-root')?.remove();
  state.client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('Assistant card opens the exact composite task in the shared draggable sheet and guards dismissal', async () => {
  await render(<>
    <AssistantScheduleCard card={{ type: 'card', cardType: 'schedule', projectID: 'project/b', taskID: 'same', name: 'Chosen task', kind: 'daily', time: '09:00', timezone: 'UTC', prompt: 'test' }} />
    <ScheduledTasksDialog />
  </>);
  await act(async () => host.querySelector<HTMLElement>('[data-assistant-contact-card]')!.click());
  await flush();
  expect(window.location.pathname).toBe(path('project/b'));
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/b:same');
  expect(document.querySelector('[data-mobile-sheet-snap-handle]')).not.toBeNull();
  expect(document.querySelector('[data-yuri-motion-id="scheduled-tasks"]')?.classList.contains('h-[98dvh]')).toBe(true);
  expect(document.querySelector('[aria-label="header.actions.backAria"]')).toBeNull();
  expect(useUIStore.getState().scheduledTaskOpenRequest).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-editor] button')!.click());
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="mobile.surface.closeAria"]')!.click());
  expect(confirm).toHaveBeenCalled();
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
  confirm.mockReturnValue(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="mobile.surface.closeAria"]')!.click());
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
  expect(window.location.pathname).toBe('/schedule');
});

test('cold links wait for data without mounting a create form; history restores another exact task', async () => {
  window.history.replaceState({}, '', path('project/a'));
  let respond!: (response: Response) => void;
  state.fetch.mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
  await render(<ScheduledTasksDialog />);
  expect(document.querySelector('[data-editor]')).toBeNull();
  expect(document.body.textContent).toContain('sessions.scheduledTasks.dialog.loading');
  await act(async () => respond(Response.json(snapshot)));
  await flush();
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/a:same');
  expect(document.querySelector('[data-yuri-motion-id="scheduled-tasks"]')?.classList.contains('h-[98dvh]')).toBe(true);
  await navigate(path('project/b'));
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/b:same');
  await navigate('/assistant/example');
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
  await navigate(path('project/a'));
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/a:same');
});

test.each(['partial', 'missing', 'error'])('%s lookup keeps the route and never opens a create form', async (failure) => {
  window.history.replaceState({}, '', path('project/a'));
  state.fetch.mockImplementation(async () => {
    if (failure === 'error') throw new Error('Offline');
    return Response.json({ tasks: [], failedProjectIds: failure === 'partial' ? ['project/a'] : [] });
  });
  await render(<ScheduledTasksDialog />);
  expect(document.querySelector('[data-editor]')).toBeNull();
  expect(window.location.pathname).toBe(path('project/a'));
  expect(document.body.textContent).toContain('common.unavailable');
});

test('desktop consumes exact task requests while an existing workspace is mounted', async () => {
  useUIStore.setState({ isMobile: false });
  await render(<ScheduledTasksWorkspace />);
  await act(async () => openScheduledTask('project/b', 'same'));
  await flush();
  expect(host.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/b:same');
  expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
  expect(window.location.pathname).toBe(path('project/b'));
});

test('the mobile root workspace does not consume the sheet request or mount a second editor', async () => {
  await render(<><ScheduledTasksWorkspace presentation="mobile-tab" /><ScheduledTasksDialog /></>);
  await act(async () => openScheduledTask('project/b', 'same'));
  await flush();
  expect(document.querySelectorAll('[data-editor]')).toHaveLength(1);
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/b:same');
  expect(host.querySelector('[data-editor]')).toBeNull();
});

test('URL-disabled hosts consume an exact task request on first mount', async () => {
  vi.stubGlobal('__VSCODE_CONFIG__', {});
  useUIStore.setState({ isMobile: false });
  openScheduledTask('project/b', 'same');
  await render(<ScheduledTasksWorkspace />);
  expect(host.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/b:same');
  expect(window.location.pathname).toBe('/assistant/example');
  expect(useUIStore.getState().scheduledTaskOpenRequest).toBeNull();
});

test('late mobile layout detection transfers a deep-linked editor to the shared sheet', async () => {
  window.history.replaceState({}, '', path('project/a'));
  useUIStore.setState({ isMobile: false });
  await render(<><ScheduledTasksWorkspace /><ScheduledTasksDialog /></>);
  expect(host.querySelector('[data-editor]')).not.toBeNull();
  await act(async () => useUIStore.setState({ isMobile: true }));
  await flush();
  expect(host.querySelector('[data-editor]')).toBeNull();
  expect(document.querySelectorAll('[data-editor]')).toHaveLength(1);
  expect(document.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('project/a:same');
});
