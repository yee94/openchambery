import { describe, expect, test } from 'bun:test';

import { buildManualProjectSessionSyncDirectories } from './sidebar/manualProjectSessionSync';

describe('buildManualProjectSessionSyncDirectories', () => {
  test('includes freshly discovered worktrees so session-index sync can cover them', () => {
    const directories = buildManualProjectSessionSyncDirectories(
      '/repo',
      [
        { path: '/repo/.worktrees/feature-a' },
        { path: '/repo/.worktrees/feature-b/' },
      ],
      {
        currentDirectory: '/repo/src',
        workspaceRoot: '/repo',
      },
    );

    expect(directories).toEqual([
      '/repo',
      '/repo/src',
      '/repo/.worktrees/feature-a',
      '/repo/.worktrees/feature-b',
    ]);
  });

  test('dedupes project root, workspace root, current directory, and worktree paths', () => {
    const directories = buildManualProjectSessionSyncDirectories(
      '/repo/',
      [
        { path: '/repo' },
        { path: '/repo/.worktrees/feature' },
        { path: '/repo/.worktrees/feature/' },
      ],
      {
        currentDirectory: '/repo',
        workspaceRoot: '/repo/',
      },
    );

    expect(directories).toEqual(['/repo', '/repo/.worktrees/feature']);
  });

  test('omits worktrees when includeWorktrees is false (VS Code workspace mode)', () => {
    const directories = buildManualProjectSessionSyncDirectories(
      '/workspace',
      [{ path: '/workspace/.worktrees/hidden' }],
      {
        currentDirectory: '/workspace/src',
        includeWorktrees: false,
      },
    );

    expect(directories).toEqual(['/workspace', '/workspace/src']);
  });

  test('falls back to project root alone when catalog is empty after refresh failure path', () => {
    const directories = buildManualProjectSessionSyncDirectories('/repo', [], {
      currentDirectory: null,
      workspaceRoot: null,
    });

    expect(directories).toEqual(['/repo']);
  });
});
