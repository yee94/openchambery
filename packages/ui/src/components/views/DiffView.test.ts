import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createToolPatchTurnDiffs,
  getFirstChangedModifiedLineFromPatch,
  mergeTurnDiffSummariesWithFull,
  turnDiffSummariesNeedFullBody,
} from './diffPatchUtils';

const diffViewSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DiffView.tsx'), 'utf-8');

describe('getFirstChangedModifiedLineFromPatch', () => {
  test('returns the first added line instead of the hunk context start', () => {
    expect(getFirstChangedModifiedLineFromPatch(`diff --git a/src/file.ts b/src/file.ts
@@ -56,10 +56,11 @@
 unchanged 58
 unchanged 59
 unchanged 60
+changed 61
 unchanged 62`)).toBe(59);
  });

  test('returns the following modified line for deletion-only hunks', () => {
    expect(getFirstChangedModifiedLineFromPatch(`@@ -10,4 +10,3 @@
 context
-removed
 after`)).toBe(11);
  });

  test('returns null when the patch has no hunk change lines', () => {
    expect(getFirstChangedModifiedLineFromPatch('Binary files a/image.png and b/image.png differ')).toBeNull();
  });
});

describe('createToolPatchTurnDiffs', () => {
  test('preserves every file from one tool invocation', () => {
    const diffs = createToolPatchTurnDiffs([
      {
        path: 'src/a.ts',
        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
      },
      {
        path: 'src/b.ts',
        patch: '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+created',
      },
    ]);

    expect(diffs.map((diff) => diff.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(diffs.map((diff) => diff.status)).toEqual(['modified', 'added']);
    expect(diffs.map((diff) => [diff.additions, diff.deletions])).toEqual([[1, 1], [1, 0]]);
  });

  test('drops empty and duplicate patch records', () => {
    const diffs = createToolPatchTurnDiffs([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/a.ts', patch: '@@ -2 +2 @@\n-left\n+right' },
      { path: 'src/b.ts', patch: '   ' },
    ]);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.file).toBe('src/a.ts');
  });
});

describe('mergeTurnDiffSummariesWithFull', () => {
  test('fills patch from full diffs while keeping summary stats', () => {
    const summaries = [
      { file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      { file: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
    ];
    const full = [
      {
        file: 'src/a.ts',
        status: 'modified',
        additions: 99,
        deletions: 99,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        file: 'src/extra.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n-x\n+y',
      },
    ];

    const merged = mergeTurnDiffSummariesWithFull(summaries, full);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      file: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-old\n+new',
      before: undefined,
      after: undefined,
    });
    expect(merged[1]).toEqual(summaries[1]);
  });

  test('leaves summaries unchanged when full fetch is empty', () => {
    const summaries = [{ file: 'src/a.ts', additions: 1, deletions: 0 }];
    const merged = mergeTurnDiffSummariesWithFull(summaries, []);
    expect(merged).toEqual(summaries);
    expect(merged).not.toBe(summaries);
  });

  test('prefers full before/after when patch is absent', () => {
    const summaries = [{ file: 'src/a.ts', additions: 1, deletions: 1 }];
    const full = [{ file: 'src/a.ts', before: 'old', after: 'new' }];
    expect(mergeTurnDiffSummariesWithFull(summaries, full)[0]).toEqual({
      file: 'src/a.ts',
      additions: 1,
      deletions: 1,
      patch: undefined,
      before: 'old',
      after: 'new',
      status: undefined,
    });
  });
});

describe('turnDiffSummariesNeedFullBody', () => {
  test('detects summary-only rows without patch body', () => {
    expect(turnDiffSummariesNeedFullBody([
      { file: 'a.ts', additions: 1, deletions: 0 },
    ])).toBe(true);
  });

  test('returns false when every row already has a body', () => {
    expect(turnDiffSummariesNeedFullBody([
      { file: 'a.ts', patch: '@@ -1 +1 @@\n-x\n+y' },
      { file: 'b.ts', before: '', after: 'created' },
    ])).toBe(false);
  });
});

describe('DiffView turn-scope on-demand session.diff contract', () => {
  test('fetches full turn patches via getSessionDiff and skips toolPatches path', () => {
    expect(diffViewSource).toContain('opencodeClient');
    expect(diffViewSource).toContain('getSessionDiff');
    expect(diffViewSource).toContain('mergeTurnDiffSummariesWithFull');
    expect(diffViewSource).toContain('turnDiffSummariesNeedFullBody');
    expect(diffViewSource).toContain('usesToolPatches');
    expect(diffViewSource).toContain("disableGitFetch={activeDiffScope === 'turn'}");
    // toolPatches path must short-circuit without session.diff
    expect(diffViewSource).toContain("if (activeDiffScope !== 'turn' || usesToolPatches)");
    // failure must not clear summary list as empty success
    expect(diffViewSource).toContain('setFetchedTurnFullDiffs(null)');
    expect(diffViewSource).toContain('turnDiffError');
  });

  test('scopes turn diffs to the owning session instead of the global current session', () => {
    // Nested/subagent panels pass sessionId; blank/absent falls back to the primary session.
    expect(diffViewSource).toContain("const resolvedSessionId = (typeof sessionId === 'string' && sessionId.trim())");
    expect(diffViewSource).toContain('        ? sessionId.trim()');
    expect(diffViewSource).toContain('        : globalSessionId;');
    // Transcript scan and session.diff fetch must both use the resolved session…
    expect(diffViewSource).toContain("useSessionMessages(resolvedSessionId ?? ''");
    expect(diffViewSource).toContain('sessionID: resolvedSessionId,');
    // …while review stays attached to the primary chat session.
    expect(diffViewSource).toContain('originalSessionID: globalSessionId,');
    // Directory: explicit panel root wins over the primary effective directory.
    expect(diffViewSource).toContain('const effectiveDirectory = (typeof directory === \'string\' && directory.trim())');
  });
});
