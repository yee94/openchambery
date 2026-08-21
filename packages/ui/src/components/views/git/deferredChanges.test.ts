import { describe, expect, test } from 'vitest';
import type { GitStatus } from '@/lib/api/types';
import {
  GIT_CHANGES_DEFERRED_THRESHOLD,
  isDeferredGitChangesStatus,
} from './deferredChanges';

const createStatus = (fileCount: number): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: Array.from({ length: fileCount }, (_, index) => ({
    path: `file-${index}.ts`,
    index: ' ',
    working_dir: 'M',
  })),
  isClean: fileCount === 0,
});

describe('isDeferredGitChangesStatus', () => {
  test('null/undefined status never defers', () => {
    expect(isDeferredGitChangesStatus(null)).toBe(false);
    expect(isDeferredGitChangesStatus(undefined)).toBe(false);
  });

  test('status at or below the threshold does not defer', () => {
    expect(isDeferredGitChangesStatus(createStatus(0))).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus(GIT_CHANGES_DEFERRED_THRESHOLD))).toBe(false);
  });

  test('status above the threshold defers', () => {
    expect(isDeferredGitChangesStatus(createStatus(GIT_CHANGES_DEFERRED_THRESHOLD + 1))).toBe(true);
  });

  test('status with missing files array does not defer', () => {
    const status = { ...createStatus(1), files: undefined } as unknown as GitStatus;
    expect(isDeferredGitChangesStatus(status)).toBe(false);
  });
});
