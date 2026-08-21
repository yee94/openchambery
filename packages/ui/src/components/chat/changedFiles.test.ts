import { describe, expect, test } from 'vitest';
import { extractGitChangedFiles, hasExtractableGitChangedFiles } from './changedFiles';

const createFiles = (
  entries: Array<{ path: string; index?: string; working_dir?: string }>,
) => entries.map((entry) => ({
  path: entry.path,
  index: entry.index ?? '',
  working_dir: entry.working_dir ?? '',
}));

describe('hasExtractableGitChangedFiles', () => {
  test('matches extractGitChangedFiles emptiness across status codes', () => {
    const files = createFiles([
      { path: 'ignored-empty.ts' },
      { path: 'ignored-ignored.ts', working_dir: '!' },
      { path: 'modified.ts', working_dir: 'M' },
      { path: 'untracked.ts', index: '?', working_dir: '?' },
      { path: 'staged.ts', index: 'A' },
      { path: 'ignored-second.ts', working_dir: '!' },
    ]);

    expect(hasExtractableGitChangedFiles(files)).toBe(extractGitChangedFiles(files, undefined, '/repo').length > 0);
  });

  test('returns false when every file is filtered out', () => {
    const files = createFiles([
      { path: 'a.ts' },
      { path: 'b.ts', working_dir: '!' },
      { path: 'c.ts', index: '!' },
    ]);

    expect(hasExtractableGitChangedFiles(files)).toBe(false);
    expect(extractGitChangedFiles(files, undefined, '/repo')).toEqual([]);
  });

  test('short-circuits on the first match (no later entries matter)', () => {
    const files = createFiles([
      { path: 'empty-then-hit.ts' },
      { path: 'hit.ts', working_dir: 'M' },
      { path: 'anything.ts' },
    ]);

    expect(hasExtractableGitChangedFiles(files)).toBe(true);
  });

  test('empty files array returns false', () => {
    expect(hasExtractableGitChangedFiles([])).toBe(false);
  });

  test('untracked index-only files count as changed', () => {
    const files = createFiles([{ path: 'untracked.ts', index: '?' }]);
    expect(hasExtractableGitChangedFiles(files)).toBe(true);
    expect(extractGitChangedFiles(files, undefined, '/repo').length).toBe(1);
  });
});
