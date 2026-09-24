import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorktreeMetadata } from '@/types/worktree';
import { dict } from '@/lib/i18n/messages/en';
import { WorkStatusCompact } from './WorkStatusCompact';
import { useWorkStatusVisibility } from './useWorkStatusVisibility';

const fixture = vi.hoisted(() => ({
  worktrees: new Map<string, WorktreeMetadata[]>(),
  attached: new Map<string, WorktreeMetadata>(),
  sessions: [] as { id: string; parentID: string; title: string }[],
  faces: [] as { key: string; sessionID?: string; seed: string; label: string; phase: 'working' | 'done' }[],
  ui: {
    workStatusPanelEnabled: true,
    isRightSidebarOpen: false,
    contextPanelByDirectory: {} as Record<string, { isOpen: boolean; tabs: { id: string }[]; activeTabId: string }>,
    openContextPanelTab: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
  },
  ensureStatus: vi.fn(),
  copy: vi.fn(async (_text: string) => ({ ok: true })),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: null }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: fixture.copy }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key]) }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (selector: (state: unknown) => unknown) => selector({
  activeProjectId: 'unrelated',
  projects: [{ id: 'project', path: '/repo', label: 'Project label' }, { id: 'unrelated', path: '/other', label: 'Wrong project' }],
}) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (selector: (state: unknown) => unknown) => selector({
  worktreeMetadata: fixture.attached, availableWorktreesByProject: fixture.worktrees,
}) }));
vi.mock('./useWorkStatusSubagents', () => ({ useWorkStatusSubagents: () => fixture.faces }));
vi.mock('@/stores/useUIStore', () => ({
  normalizeContextPanelDirectoryKey: (directory: string) => directory,
  useUIStore: (selector: (state: unknown) => unknown) => selector(fixture.ui),
}));
vi.mock('@/stores/useGitStore', () => ({
  useGitStore: (selector: (state: unknown) => unknown) => selector({ ensureStatus: fixture.ensureStatus }),
  useGitStatus: () => ({ current: 'feature/topic', files: [{ path: 'a' }, { path: 'b' }], diffStats: {
    a: { insertions: 5, deletions: 2 }, b: { insertions: 3, deletions: 1 },
  } }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.worktrees.clear();
  fixture.attached.clear();
  fixture.sessions = [];
  fixture.faces = [];
  fixture.worktrees.set('/repo', [{ path: '/trees/topic', projectDirectory: '/repo', branch: 'old-branch', label: 'old-branch', name: 'topic', worktreeStatus: 'ready' }]);
  fixture.ui.isRightSidebarOpen = false;
  fixture.ui.contextPanelByDirectory = {};
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('resolves an external worktree to its project, copies the branch, and opens Git from changes', async () => {
  await act(async () => root.render(<WorkStatusCompact sessionId="s" directory="/trees/topic" />));
  expect(host.textContent).toBe('Project labelfeature/topictopicChanges+8−3');
  expect(host.querySelectorAll('button')).toHaveLength(3);
  expect(host.querySelector('[title^="Worktree:"] use')?.getAttribute('href')).toBe('#oc-node-tree');
  expect(host.querySelector('[title="Worktree"]')?.getAttribute('title')).toBe('Worktree');
  expect(host.querySelector('[title="Current branch"]')?.getAttribute('title')).toBe('Current branch');
  expect(host.querySelector('[aria-label="Copy Worktree Path"]')?.className).not.toContain('ml-auto');
  expect(host.querySelector('[aria-label="Copy branch name"]')?.className).toContain('oc-work-status-action');
  expect(host.querySelector('[aria-label="Copy Worktree Path"]')?.className).toContain('oc-work-status-action');
  expect(host.querySelector('[aria-label="Open Git panel"]')?.className).toContain('oc-work-status-action');
  expect(host.querySelector('[title^="Current branch:"]')?.className ?? '').not.toContain('oc-work-status-action');
  const copyBranch = host.querySelector<HTMLButtonElement>('[aria-label="Copy branch name"]');
  await act(async () => copyBranch?.click());
  expect(fixture.copy).toHaveBeenCalledWith('feature/topic');
  expect(copyBranch?.querySelector('use')?.getAttribute('href')).toBe('#oc-check');
  const copyButton = host.querySelector<HTMLButtonElement>('[aria-label="Copy Worktree Path"]');
  await act(async () => copyButton?.click());
  expect(fixture.copy).toHaveBeenCalledWith('/trees/topic');
  expect(copyButton?.querySelector('use')?.getAttribute('href')).toBe('#oc-check');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open Git panel"]')?.click());
  expect(fixture.ui.openContextPanelTab).not.toHaveBeenCalled();
  expect(fixture.ui.setRightSidebarTab).toHaveBeenCalledWith('git');
  expect(fixture.ui.setRightSidebarOpen).toHaveBeenCalledWith(true);
});

it('renders a collapsed agent disclosure with stacked faces and expandable status rows', async () => {
  fixture.faces = [
    { key: 'done-1', sessionID: 'child-1', seed: 'done-1', label: 'Explore', phase: 'done' },
    ...Array.from({ length: 3 }, (_, index) => ({ key: `live-${index}`, seed: `live-${index}`, label: `Live ${index}`, phase: 'working' as const })),
  ];
  await act(async () => root.render(<WorkStatusCompact sessionId="s" directory="/repo" />));
  const stack = host.querySelector('[role="group"][aria-label="Subagents"]');
  expect(stack?.querySelectorAll('[data-agent-avatar]')).toHaveLength(3);
  expect(stack?.querySelector('[aria-label="Explore"]')).not.toBeNull();
  expect(stack?.querySelector('.-ml-1')).not.toBeNull();
  expect(stack?.textContent).toContain('3 working·1 done');
  const disclosure = stack?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  expect(disclosure).not.toBeNull();
  expect(stack?.querySelector('[id][hidden]')).not.toBeNull();
  await act(async () => disclosure?.click());
  expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
  const groups = stack?.querySelectorAll('section');
  expect(groups).toHaveLength(2);
  expect(groups?.[0].getAttribute('aria-label')).toBe('3 working');
  expect(groups?.[0].textContent).toContain('Live 0');
  expect(groups?.[1].getAttribute('aria-label')).toBe('1 done');
  expect(groups?.[1].textContent).toContain('Explore');
  expect(stack?.querySelector('[data-agent-avatar-shape="circle"]')).toBeNull();
  const childButton = stack?.querySelector<HTMLButtonElement>('[id] button:not(:disabled)');
  await act(async () => childButton?.click());
  expect(fixture.ui.openContextPanelTab).toHaveBeenCalledWith('/repo', {
    mode: 'chat', dedupeKey: 'session:child-1', label: 'Explore', readOnly: true,
  });
  fixture.faces = fixture.faces.map((face) => ({ ...face, phase: 'done' }));
  await act(async () => root.render(<WorkStatusCompact sessionId="s" directory="/repo" />));
  expect(disclosure?.textContent).toContain('0 working·4 done');
  expect(stack?.querySelectorAll('section')).toHaveLength(1);
  expect(stack?.querySelector('section')?.getAttribute('aria-label')).toBe('4 done');
  fixture.faces = [];
  await act(async () => root.render(<WorkStatusCompact sessionId="s" directory="/repo" />));
  expect(host.querySelector('[role="group"]')).toBeNull();
});

it('does not reuse attached worktree metadata after changing the displayed directory', async () => {
  fixture.attached.set('s', fixture.worktrees.get('/repo')![0]);
  await act(async () => root.render(<WorkStatusCompact sessionId="s" directory="/repo" />));
  expect(host.textContent).toBe('Project labelfeature/topicChanges+8−3');
  expect(host.querySelector('[title^="Worktree:"]')).toBeNull();
});

it('excludes both panel modes when the displayed directory has context open or the sidebar is open', async () => {
  function Probe({ directory }: { directory: string }) {
    const { layoutAllows } = useWorkStatusVisibility({ isMobile: false, isVSCode: false, directory });
    return <span>{String(layoutAllows)}</span>;
  }
  fixture.ui.contextPanelByDirectory['/repo'] = { isOpen: true, tabs: [{ id: 'context' }], activeTabId: 'context' };
  await act(async () => root.render(<Probe directory="/repo" />));
  expect(host.textContent).toBe('false');
  await act(async () => root.render(<Probe directory="/other" />));
  expect(host.textContent).toBe('true');
  fixture.ui.isRightSidebarOpen = true;
  await act(async () => root.render(<Probe directory="/other" />));
  expect(host.textContent).toBe('false');
  fixture.ui.isRightSidebarOpen = false;
  await act(async () => root.render(<Probe directory="/other" />));
  expect(host.textContent).toBe('true');
  expect(fixture.ui.workStatusPanelEnabled).toBe(true);
});
