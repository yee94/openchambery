import { describe, expect, it } from 'vitest';

import {
  buildSimpleDiffText,
  isStagedGitFile,
  isUnstagedGitFile,
  parseGitStatus,
} from '@/lib/gitChangesApi';

describe('parseGitStatus', () => {
  it('parses Cap git status payload', () => {
    const status = parseGitStatus({
      current: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 0,
      isClean: false,
      files: [
        { path: 'a.ts', index: 'M', working_dir: '' },
        { path: 'b.ts', index: '', working_dir: 'M' },
        { path: 'c.ts', index: '?', working_dir: '?' },
      ],
    });
    expect(status.current).toBe('main');
    expect(status.files).toHaveLength(3);
    expect(isStagedGitFile(status.files[0]!)).toBe(true);
    expect(isUnstagedGitFile(status.files[1]!)).toBe(true);
    expect(isUnstagedGitFile(status.files[2]!)).toBe(true);
  });
});

describe('buildSimpleDiffText', () => {
  it('marks binary and unchanged', () => {
    expect(buildSimpleDiffText({ original: 'a', modified: 'a', path: 'x', isBinary: true })).toBe(
      '(binary file)',
    );
    expect(buildSimpleDiffText({ original: 'a\n', modified: 'a\n', path: 'x' })).toBe(
      '(no textual changes)',
    );
    const text = buildSimpleDiffText({ original: 'a\n', modified: 'b\n', path: 'x' });
    expect(text).toContain('-a');
    expect(text).toContain('+b');
  });
});
