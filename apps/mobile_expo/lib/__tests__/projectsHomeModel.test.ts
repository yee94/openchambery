import { describe, expect, it } from 'vitest';

import {
  buildProjectsHomeModel,
  createSessionOwnershipIndex,
  filterProjectsHomeForSearch,
  formatRelativeShort,
  gitWorktreesToMetadata,
  listProjectAreaRootSessions,
} from '@/lib/projectsHomeModel';
import type { ProjectEntry } from '@/lib/projectsSettingsApi';
import type { SessionIndexSnapshot } from '@/lib/sessionIndex';
import { orderWorktrees } from '@/lib/worktreeOrderApi';

const snapshot = (): SessionIndexSnapshot => ({
  available: true,
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/code/openchamber', '/code/openchamber-wt'],
    failedDirectories: [],
  },
  directories: [
    {
      directory: '/code/openchamber',
      cursor: null,
      hasMore: false,
      sessions: [
        {
          id: 'pinned-1',
          title: 'Pinned',
          time: { created: 100, updated: 500, pinned: '2026-01-01' },
          project: { branch: 'main' },
        },
        {
          id: 'main-1',
          title: 'Main session',
          time: { created: 50, updated: 400 },
          project: { branch: 'main' },
        },
        {
          id: 'child-1',
          title: 'Subagent',
          parentID: 'main-1',
          time: { created: 51, updated: 401 },
        },
      ],
    },
    {
      directory: '/code/openchamber-wt',
      cursor: null,
      hasMore: false,
      sessions: [
        {
          id: 'wt-1',
          title: 'Worktree session',
          time: { created: 60, updated: 450 },
          project: { branch: 'feat/home', worktree: '/code/openchamber-wt' },
        },
      ],
    },
  ],
  pinnedSessionIds: ['pinned-1'],
});

const projects = (): ProjectEntry[] => [
  {
    id: 'proj-1',
    path: '/code/openchamber',
    label: 'OpenChamber',
    icon: 'code',
    color: 'primary',
  },
];

describe('gitWorktreesToMetadata', () => {
  it('drops the project root and keeps secondary worktrees', () => {
    const meta = gitWorktreesToMetadata('/code/openchamber', [
      { head: 'a', name: 'main', branch: 'main', path: '/code/openchamber' },
      { head: 'b', name: 'feat-home', branch: 'feat/home', path: '/code/openchamber-wt' },
    ]);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.path).toBe('/code/openchamber-wt');
    expect(meta[0]?.branch).toBe('feat/home');
  });
});

describe('orderWorktrees', () => {
  it('applies Cap display order', () => {
    const ordered = orderWorktrees(
      ['/b', '/a'],
      [
        { path: '/a', branch: 'a', label: 'a', projectDirectory: '/root' },
        { path: '/b', branch: 'b', label: 'b', projectDirectory: '/root' },
      ],
    );
    expect(ordered.map((w) => w.path)).toEqual(['/b', '/a']);
  });
});

describe('createSessionOwnershipIndex', () => {
  it('assigns worktree sessions to worktree scope', () => {
    const flat = [
      { id: 'main-1', directory: '/code/openchamber' },
      { id: 'wt-1', directory: '/code/openchamber-wt' },
    ];
    const ownership = createSessionOwnershipIndex(
      flat,
      [{ id: 'proj-1', path: '/code/openchamber' }],
      new Map([
        [
          '/code/openchamber',
          [
            {
              path: '/code/openchamber-wt',
              branch: 'feat/home',
              label: 'feat/home',
              projectDirectory: '/code/openchamber',
            },
          ],
        ],
      ]),
    );
    expect(ownership.get('main-1')?.kind).toBe('project');
    expect(ownership.get('wt-1')?.kind).toBe('worktree');
    expect(ownership.get('wt-1')?.scopeDirectory).toBe('/code/openchamber-wt');
  });
});

describe('buildProjectsHomeModel', () => {
  it('groups into project shell + inset worktree groups + flat session rows', () => {
    const model = buildProjectsHomeModel(snapshot(), projects(), {
      worktreesByProjectPath: new Map([
        [
          '/code/openchamber',
          [
            {
              path: '/code/openchamber-wt',
              branch: 'feat/home',
              label: 'feat/home',
              projectDirectory: '/code/openchamber',
            },
          ],
        ],
      ]),
      now: 1_000,
    });

    expect(model.projects).toHaveLength(1);
    const project = model.projects[0]!;
    expect(project.name).toBe('OpenChamber');
    expect(project.worktrees.map((w) => w.kind)).toEqual(['main', 'worktree']);
    const main = project.worktrees.find((w) => w.kind === 'main')!;
    const wt = project.worktrees.find((w) => w.kind === 'worktree')!;
    expect(main.sessions.map((s) => s.id)).toEqual(['main-1']);
    expect(wt.sessions.map((s) => s.id)).toEqual(['wt-1']);
    expect(model.pinnedSessions.map((s) => s.id)).toEqual(['pinned-1']);
    expect(model.pinnedSessions[0]?.subtitle).toBe('OpenChamber · main');
    expect(wt.sessions[0]?.subtitle).toBe('OpenChamber · feat/home');
  });

  it('synthesizes projects from directories when settings are empty', () => {
    const model = buildProjectsHomeModel(snapshot(), [], { now: 1_000 });
    expect(model.projects.length).toBeGreaterThan(0);
    expect(model.catalog.some((s) => s.id === 'main-1')).toBe(true);
  });
});

describe('listProjectAreaRootSessions', () => {
  it('omits pinned and nested subagents', () => {
    const roots = listProjectAreaRootSessions(
      [
        { id: 'a', parentID: null },
        { id: 'b', parentID: 'a' },
        { id: 'c', parentID: null },
      ],
      new Set(['c']),
    );
    expect(roots.map((s) => s.id)).toEqual(['a']);
  });
});

describe('filterProjectsHomeForSearch', () => {
  it('searches catalog across project shells', () => {
    const model = buildProjectsHomeModel(snapshot(), projects(), {
      worktreesByProjectPath: new Map([
        [
          '/code/openchamber',
          [
            {
              path: '/code/openchamber-wt',
              branch: 'feat/home',
              label: 'feat/home',
              projectDirectory: '/code/openchamber',
            },
          ],
        ],
      ]),
    });
    const result = filterProjectsHomeForSearch(model, 'Worktree session');
    expect(result.sessions.map((s) => s.id)).toEqual(['wt-1']);
  });
});

describe('formatRelativeShort', () => {
  it('formats compact relative labels', () => {
    const now = 1_000_000;
    expect(formatRelativeShort(now - 10_000, now)).toBe('now');
    expect(formatRelativeShort(now - 120_000, now)).toBe('2m');
  });
});
