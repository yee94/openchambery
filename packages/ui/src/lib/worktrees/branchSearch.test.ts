import { describe, expect, test } from 'bun:test';

import { rankBranchesForQuery } from './branchSearch';

describe('rankBranchesForQuery', () => {
  test('ranks exact origin/master first instead of alphabetical noise', () => {
    const result = rankBranchesForQuery({
      localBranches: [
        'backup/feat-effect-refactor-pre-master-1e558c6c-20260625-183700',
        'codex/master-update-review-20260702',
        'compare/master-features',
        'master',
      ],
      remoteBranches: [
        'origin/backup_mbizwxaaigent_a2a_phase_1',
        'origin/codex/master-update-review-20260702',
        'origin/d14-eval',
        'origin/master',
      ],
      query: 'origin/master',
    });

    expect(result.matching[0]).toEqual({
      label: 'origin/master',
      value: 'remotes/origin/master',
      source: 'remote',
    });
  });

  test('prefers local exact match over remote when both match equally', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main'],
      remoteBranches: ['origin/main'],
      query: 'main',
    });

    expect(result.matching.map((branch) => branch.value)).toEqual([
      'main',
      'remotes/origin/main',
    ]);
  });

  test('keeps non-matching branches in other groups when query is active', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main', 'feature/foo'],
      remoteBranches: ['origin/main', 'origin/bar'],
      query: 'main',
    });

    expect(result.matching.map((branch) => branch.label)).toEqual(['main', 'origin/main']);
    expect(result.otherLocal).toEqual(['feature/foo']);
    expect(result.otherRemote).toEqual(['origin/bar']);
  });

  test('returns full local/remote lists when query is empty', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main', 'dev'],
      remoteBranches: ['origin/main'],
      query: '   ',
    });

    expect(result.matching).toEqual([]);
    expect(result.otherLocal).toEqual(['main', 'dev']);
    expect(result.otherRemote).toEqual(['origin/main']);
  });
});
