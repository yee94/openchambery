import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidebarProjectsList } from './SidebarProjectsList';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

const counters = vi.hoisted(() => ({ project: 0 }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/projectMeta', () => ({ PROJECT_COLOR_MAP: {}, PROJECT_ICON_MAP: {}, ProjectIconImage: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLElement, { children: React.ReactNode }>(function Overlay({ children }, ref) {
    return <div ref={ref as React.Ref<HTMLDivElement>}>{children}</div>;
  }),
}));
vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@dnd-kit/core')>(),
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: () => null,
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: ({ id }: { id: string }) => {
    if (id === 'project') counters.project += 1;
    return { attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: undefined, isDragging: false };
  },
  arrayMove: (items: unknown[]) => items,
  sortableKeyboardCoordinates: () => {}, verticalListSortingStrategy: () => {},
}));
vi.mock('@/stores/useGlobalSessionsStore', async () => {
  const { create } = await import('zustand');
  return { useGlobalSessionsStore: create(() => ({ loadingDirectories: new Set<string>(), refreshingDirectories: new Set<string>() })) };
});
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({ availableWorktreesByProject: new Map() })) };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host); counters.project = 0;
  useGlobalSessionsStore.setState({ loadingDirectories: new Set(), refreshingDirectories: new Set() });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

it('skips project hook and body work across 50 unrelated parent commits, and invokes current actions', async () => {
  const noop = () => {};
  const renderGroupSessions = vi.fn(() => <span data-session>Session</span>);
  const section = {
    project: { id: 'project', normalizedPath: '/project' },
    groups: [{ id: 'root', label: 'Root', branch: null, description: null, isMain: true, worktree: null, directory: '/project', sessions: [] }],
  };
  const onNewSession = vi.fn();
  const props: React.ComponentProps<typeof SidebarProjectsList> = {
    hasLeadingSection: false, sectionsForRender: [section], projectSections: [section], activeProjectId: 'project',
    showOnlyMainWorkspace: false, hasSessionSearchQuery: false, emptyState: null, searchEmptyState: null,
    renderGroupSessions, homeDirectory: null, collapsedProjects: new Set(), hideDirectoryControls: false,
    projectRepoStatus: new Map(), mobileVariant: false,
    alwaysShowActions: true, toggleProject: noop, setActiveProjectIdOnly: noop, setActiveMainTab: noop,
    setSessionSwitcherOpen: noop, openNewSessionDraft: onNewSession, openNewWorktreeDialog: noop,
    syncProjectSessions: noop, openProjectEditDialog: noop, removeProject: noop,
    reorderProjects: noop, projectSortOrder: 'manual',
    getOrderedGroups: (_id, groups) => groups, setGroupOrderByProject: noop, openSidebarMenuKey: null,
    setOpenSidebarMenuKey: noop, isInlineEditing: false,
  };
  await act(async () => root.render(<SidebarProjectsList {...props} topContent={<span>0</span>} />));
  const initial = counters.project;
  for (let index = 1; index <= 50; index += 1) {
    await act(async () => root.render(<SidebarProjectsList {...props} topContent={<span>{index}</span>} />));
  }
  expect(counters.project - initial).toBe(0);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  const row = host.querySelector('[data-session]');
  for (let index = 0; index < 50; index += 1) {
    await act(async () => useGlobalSessionsStore.setState({
      loadingDirectories: new Set([`/other-${index}`]),
      refreshingDirectories: new Set([`/other-${index}`]),
    }));
  }
  expect(counters.project - initial).toBe(0);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  await act(async () => useGlobalSessionsStore.setState({ loadingDirectories: new Set(['/project']) }));
  expect(counters.project).toBeGreaterThan(initial);
  expect(renderGroupSessions).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-session]')).toBe(row);
  const latestAction = vi.fn();
  await act(async () => root.render(<SidebarProjectsList {...props} openNewSessionDraft={latestAction} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="sessions.sidebar.project.actions.newSession"]')!.click());
  expect(latestAction).toHaveBeenCalledWith({ directoryOverride: '/project' });
  expect(onNewSession).not.toHaveBeenCalled();
});
