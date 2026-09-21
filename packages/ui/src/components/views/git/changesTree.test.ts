import { describe, expect, test } from 'vitest';

import { getChangesTreeFileName } from './changesTree';

describe('getChangesTreeFileName', () => {
  test('strips parent directories so tree rows can show the basename only', () => {
    expect(getChangesTreeFileName('response/i.ts')).toBe('i.ts');
    expect(getChangesTreeFileName('/response/R.md')).toBe('R.md');
    expect(getChangesTreeFileName('pipeline/a2a/driveA.ts')).toBe('driveA.ts');
    expect(getChangesTreeFileName('pipeline\\devtools\\drive.ts')).toBe('drive.ts');
  });

  test('keeps a root-level file name unchanged', () => {
    expect(getChangesTreeFileName('README.md')).toBe('README.md');
    expect(getChangesTreeFileName('/README.md')).toBe('README.md');
  });
});
