import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { useSessionSidebarSections } from './useSessionSidebarSections';
import { useSessionGrouping } from './useSessionGrouping';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/stores/useGlobalSessionsStore', () => ({ resolveGlobalSessionDirectory: (session: Session) => session.directory }));
const translate = (key: string) => key;

it('keeps unrelated project/group renders at zero across 50 catalog updates and refreshes changed trees', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projects = ['a', 'b'].map((id) => ({ id, path: `/${id}`, normalizedPath: `/${id}` }));
  const session = (id: string, directory: string, title = id): Session => ({
    id, directory, title, slug: id, projectID: directory, version: '1', time: { created: 1, updated: 1 },
  });
  const first = session('a-1', '/a');
  const second = session('b-1', '/b');
  const metadata = new Map();
  const worktrees = new Map();
  const repoStatus = new Map<string, boolean>();
  const rootBranches = new Map();
  const pins = new Set<string>();
  const branches = new Map();
  const folders = {};
  const renders = new Map<string, number>();
  const Group = React.memo(function Group({ group }: { group: ReturnType<typeof useSessionSidebarSections>['projectSections'][number]['groups'][number] }) {
    const key = `${group.directory}:${group.id}`;
    renders.set(key, (renders.get(key) ?? 0) + 1);
    return <span>{group.sessions.map((node) => node.session.title).join(',')}</span>;
  });
  let snapshot: ReturnType<typeof useSessionSidebarSections>;
  function Model({ sessions, query = '' }: { sessions: Session[]; query?: string }) {
    const grouping = useSessionGrouping({ homeDirectory: null, worktreeMetadata: metadata, pinnedSessionIds: pins, gitBranches: branches, isVSCode: false });
    snapshot = useSessionSidebarSections({
      ...grouping, normalizedProjects: projects,
      getSessionsForProject: (id) => sessions.filter((row) => row.directory === `/${id}`),
      getArchivedSessionsForProject: () => [], availableWorktreesByProject: worktrees,
      projectRepoStatus: repoStatus, projectRootBranches: rootBranches, lastRepoStatus: false,
      hasSessionSearchQuery: Boolean(query), normalizedSessionSearchQuery: query, foldersMap: folders,
    });
    return snapshot.sectionsForRender.map((section) => <div key={section.project.id}>
      {section.groups.map((group) => <Group key={group.id} group={group} />)}
    </div>);
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Model sessions={[first, second]} />));
    const original = snapshot!;
    const initial = renders.get('/a:root')!;
    for (let i = 0; i < 50; i++) {
      await act(async () => root.render(<Model sessions={[first, { ...second, title: `b-${i}` }]} />));
    }
    expect(renders.get('/a:root')! - initial).toBe(0);
    expect(snapshot!.projectSections[0]).toBe(original.projectSections[0]);
    expect(snapshot!.groupSearchDataByGroup).toBe(original.groupSearchDataByGroup);
    expect(host.textContent).toContain('b-49');
    await act(async () => root.render(<Model sessions={[{ ...first, title: 'renamed' }, second]} />));
    expect(renders.get('/a:root')! - initial).toBe(1);
    expect(host.textContent).toContain('renamed');
    await act(async () => root.render(<Model sessions={[first, second]} query="b-1" />));
    expect(snapshot!.sectionsForRender.map((section) => section.project.id)).toEqual(['b']);
    expect(snapshot!.searchMatchCount).toBe(1);
    await act(async () => root.render(<Model sessions={[first]} />));
    expect(snapshot!.projectSections[1].groups[0].sessions).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
