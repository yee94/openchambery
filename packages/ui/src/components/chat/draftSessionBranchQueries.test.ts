import { describe, expect, test } from 'bun:test';
import {
  canQueryDraftGitBranches,
  resolveDraftBranchListDirectory,
  splitGitBranchList,
} from './draftSessionBranchQueries';

describe('resolveDraftBranchListDirectory', () => {
  test('prefers the project root so worktree selection keeps the shared list scope', () => {
    expect(resolveDraftBranchListDirectory(
      '/repo',
      '/repo/.worktrees/feat-a',
    )).toBe('/repo');
  });

  test('falls back to the selected directory when project root is unknown', () => {
    expect(resolveDraftBranchListDirectory(null, '/repo/.worktrees/feat-a'))
      .toBe('/repo/.worktrees/feat-a');
  });
});

describe('canQueryDraftGitBranches', () => {
  test('stays enabled while the repo probe is still null (worktree switch race)', () => {
    // Regression: DraftSessionBranchSelector used `isGitRepo === true`, which
    // disabled the Query after selecting a worktree and painted empty lists.
    expect(canQueryDraftGitBranches('/repo/.worktrees/feat-a', null)).toBe(true);
    expect(canQueryDraftGitBranches('/repo', null)).toBe(true);
  });

  test('enables known git directories and disables non-git directories', () => {
    expect(canQueryDraftGitBranches('/repo', true)).toBe(true);
    expect(canQueryDraftGitBranches('/not-git', false)).toBe(false);
  });

  test('disables empty directories', () => {
    expect(canQueryDraftGitBranches(null, null)).toBe(false);
    expect(canQueryDraftGitBranches('', true)).toBe(false);
  });
});

describe('splitGitBranchList', () => {
  test('splits and sorts local vs remote refs', () => {
    expect(splitGitBranchList([
      'main',
      'feat/a',
      'remotes/origin/main',
      'remotes/origin/feat/a',
    ])).toEqual({
      localBranches: ['feat/a', 'main'],
      remoteBranches: ['origin/feat/a', 'origin/main'],
    });
  });

  test('returns empty lists when the authoritative payload is missing', () => {
    expect(splitGitBranchList(undefined)).toEqual({ localBranches: [], remoteBranches: [] });
    expect(splitGitBranchList([])).toEqual({ localBranches: [], remoteBranches: [] });
  });
});
