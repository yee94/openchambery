import { describe, expect, test } from 'vitest';
import { resolveTurnChangedFileOpenTarget } from './openTurnChangedFile';

describe('resolveTurnChangedFileOpenTarget', () => {
  test('keeps in-project paths on the turn-diff path', () => {
    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      'packages/ui/src/app.ts',
    )).toEqual({
      kind: 'diff',
      path: 'packages/ui/src/app.ts',
    });

    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      '/Users/dev/Code/github/yuri/packages/ui/src/app.ts',
    )).toEqual({
      kind: 'diff',
      path: 'packages/ui/src/app.ts',
    });
  });

  test('degrades outside-workspace absolute paths to file preview with notice', () => {
    expect(resolveTurnChangedFileOpenTarget(
      '/Users/dev/Code/github/yuri',
      '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md',
    )).toEqual({
      kind: 'file',
      path: '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md',
      notice: 'turn-diff-outside-workspace',
    });
  });
});
