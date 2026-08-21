import { describe, expect, test } from 'vitest';
import type { GitStatus } from '@/lib/api/types';
import { isDeferredGitChangesStatus } from './deferredChanges';

const createStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [{ path: 'file.ts', index: ' ', working_dir: 'M' }],
  isClean: false,
  ...overrides,
});

describe('isDeferredGitChangesStatus', () => {
  test('defers only when the server marks the status oversized', () => {
    expect(isDeferredGitChangesStatus(createStatus({ oversized: true }))).toBe(true);
  });

  test('does not defer when the server omits the flag', () => {
    expect(isDeferredGitChangesStatus(createStatus())).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus({ oversized: false }))).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus({ oversized: undefined }))).toBe(false);
  });

  test('null/undefined status never defers', () => {
    expect(isDeferredGitChangesStatus(null)).toBe(false);
    expect(isDeferredGitChangesStatus(undefined)).toBe(false);
  });

  test('client never applies its own file-count threshold', () => {
    // The server owns the threshold; a huge files array without the server
    // flag must NOT defer (the client no longer second-guesses the server).
    const hugeButNotMarked = createStatus({
      files: Array.from({ length: 100_000 }, (_, index) => ({
        path: `file-${index}.ts`,
        index: ' ',
        working_dir: 'M',
      })),
    });
    expect(isDeferredGitChangesStatus(hugeButNotMarked)).toBe(false);
  });
});
