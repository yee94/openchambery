import { describe, expect, test } from 'vitest';
import { fileDiffFromPatch } from './patchFileDiff';
import { extractDiffSelectedCode } from './extractDiffSelectedCode';

const PARTIAL_PATCH = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -8,7 +8,8 @@
 context before 1
 context before 2
-old line
+new line
+extra line
 context after 1
 context after 2
`;

const MULTI_HUNK_PATCH = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 line1
+added-top
 line2
 line3
@@ -10,3 +11,4 @@
 line10
-deleted-mid
 line11
+added-bottom
`;

describe('extractDiffSelectedCode', () => {
  test('maps partial patch file line numbers into additionLines (red repro)', () => {
    const fileDiff = fileDiffFromPatch('foo.ts', PARTIAL_PATCH);
    expect(fileDiff.isPartial).toBe(true);

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 8, end: 10, side: 'additions' }),
    ).toBe('context before 1\ncontext before 2\nnew line');

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 10, end: 11, side: 'additions' }),
    ).toBe('new line\nextra line');
  });

  test('maps deletions side for partial patches', () => {
    const fileDiff = fileDiffFromPatch('foo.ts', PARTIAL_PATCH);
    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 10, end: 10, side: 'deletions' }),
    ).toBe('old line');
  });

  test('maps multi-hunk partial selections across hunk gaps', () => {
    const fileDiff = fileDiffFromPatch('foo.ts', MULTI_HUNK_PATCH);
    expect(fileDiff.isPartial).toBe(true);

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 1, end: 2, side: 'additions' }),
    ).toBe('line1\nadded-top');

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 11, end: 14, side: 'additions' }),
    ).toBe('line10\nline11\nadded-bottom');

    // Gap between hunks (file lines 5-10) has no mapped addition lines — skip
    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 5, end: 10, side: 'additions' }),
    ).toBe('');

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 11, end: 11, side: 'deletions' }),
    ).toBe('deleted-mid');
  });

  test('returns empty string for out-of-range partial selections', () => {
    const fileDiff = fileDiffFromPatch('foo.ts', PARTIAL_PATCH);
    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 1, end: 3, side: 'additions' }),
    ).toBe('');
    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 100, end: 110, side: 'additions' }),
    ).toBe('');
  });

  test('uses 1-based array indexes for non-partial fileDiff', () => {
    const fileDiff = {
      ...fileDiffFromPatch('foo.ts', PARTIAL_PATCH),
      isPartial: false,
      additionLines: ['a\n', 'b\n', 'c\n'],
      deletionLines: ['x\n', 'y\n'],
      hunks: [],
    };

    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 1, end: 2, side: 'additions' }),
    ).toBe('a\nb');
    expect(
      extractDiffSelectedCode('', '', fileDiff, { start: 2, end: 2, side: 'deletions' }),
    ).toBe('y');
  });

  test('falls back to original/modified when fileDiff is absent', () => {
    const original = 'old1\nold2\nold3';
    const modified = 'new1\nnew2\nnew3';

    expect(
      extractDiffSelectedCode(original, modified, undefined, {
        start: 2,
        end: 3,
        side: 'additions',
      }),
    ).toBe('new2\nnew3');

    expect(
      extractDiffSelectedCode(original, modified, undefined, {
        start: 1,
        end: 1,
        side: 'deletions',
      }),
    ).toBe('old1');
  });
});
