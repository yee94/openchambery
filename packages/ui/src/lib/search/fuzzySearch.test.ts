import { describe, expect, test } from 'bun:test';

import {
  partitionByFuzzyQuery,
  scoreByFuzzyQuery,
  scoreTextAgainstQuery,
} from './fuzzySearch';

describe('scoreTextAgainstQuery', () => {
  test('ranks exact ahead of prefix, boundary, and mid-string', () => {
    const query = 'origin/master';
    const exact = scoreTextAgainstQuery('origin/master', query);
    const prefix = scoreTextAgainstQuery('origin/master-backup', query);
    const boundary = scoreTextAgainstQuery('remotes/origin/master', query);
    const mid = scoreTextAgainstQuery('xorigin/master', query);

    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(exact!).toBeLessThan(prefix!);
    expect(prefix!).toBeLessThan(boundary!);
    expect(boundary!).toBeLessThan(mid!);
  });

  test('returns null when query is not a substring', () => {
    expect(scoreTextAgainstQuery('backup/pre-master', 'origin/master')).toBeNull();
  });
});

describe('scoreByFuzzyQuery', () => {
  test('puts exact origin/master ahead of partial master hits', () => {
    const branches = [
      'backup/feat-effect-refactor-pre-master-1e558c6c-20260625-183700',
      'backup/feat-effect-refactor-pre-master-d5fbe040-20260624-merge',
      'codex/master-update-review-20260702',
      'compare/master-features',
      'origin/backup_mbizwxaaigent_a2a_phase_1',
      'origin/codex/master-update-review-20260702',
      'origin/d14-eval',
      'origin/master',
    ];

    const ranked = scoreByFuzzyQuery(branches, 'origin/master', (branch) => branch)
      .map((entry) => entry.item);

    expect(ranked[0]).toBe('origin/master');
  });

  test('prefers shorter prefix matches when scores otherwise tie on tier', () => {
    const ranked = scoreByFuzzyQuery(
      ['master-long-suffix', 'master'],
      'master',
      (branch) => branch,
      { noFuzzy: true },
    ).map((entry) => entry.item);

    expect(ranked[0]).toBe('master');
    expect(ranked[1]).toBe('master-long-suffix');
  });

  test('scores multi-field candidates by the best field', () => {
    const items = [
      { name: 'other', description: 'origin/master helper' },
      { name: 'origin/master', description: 'default branch' },
    ];

    const ranked = scoreByFuzzyQuery(
      items,
      'origin/master',
      (item) => [item.name, item.description],
      { noFuzzy: true },
    ).map((entry) => entry.item.name);

    expect(ranked[0]).toBe('origin/master');
  });
});

describe('partitionByFuzzyQuery', () => {
  test('returns matching items in relevance order', () => {
    const { matching, other } = partitionByFuzzyQuery(
      [
        'backup/pre-master',
        'origin/master',
        'feature/foo',
        'origin/master-hotfix',
      ],
      'origin/master',
      (branch) => branch,
    );

    expect(matching[0]).toBe('origin/master');
    expect(matching).toContain('origin/master-hotfix');
    expect(other).toContain('feature/foo');
  });
});
