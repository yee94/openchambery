import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createToolPatchTurnDiffs,
  getFirstChangedModifiedLineFromPatch,
} from './diffPatchUtils';
import { projectTurnDiffStats } from '../chat/lib/turns/projectTurnSummary';
import type { ChatMessageEntry } from '../chat/lib/turns/types';

const diffViewSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DiffView.tsx'), 'utf-8');
const messageBodySource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../chat/message/MessageBody.tsx'), 'utf-8');

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

describe('projectTurnDiffStats L1 marker contract', () => {
  const userMessage = (summary: object): ChatMessageEntry => ({
    info: { id: 'user-1', role: 'user', sessionID: 'session-1', summary } as ChatMessageEntry['info'],
    parts: [],
  });

  test('projects a count-only changes marker', () => {
    expect(projectTurnDiffStats(userMessage({ diffCount: 463, hasDiffs: true }))).toEqual({
      additions: 0,
      deletions: 0,
      files: 463,
      hasDiffs: true,
    });
  });

  test('keeps legacy summary diffs compatible', () => {
    expect(projectTurnDiffStats(userMessage({
      diffs: [{ file: 'a.ts', additions: 2, deletions: 1 }],
    }))).toEqual({ additions: 2, deletions: 1, files: 1, hasDiffs: true });
  });
});

describe('Turn Changes preview contract', () => {
  test('renders a count-only entry and opens a stable turn diff tab on desktop', () => {
    expect(messageBodySource).toContain('fileCount={turnGroupingContext.diffStats.files}');
    expect(messageBodySource).not.toContain('data-turn-change-file');
    expect(messageBodySource).toContain("mode: 'diff'");
    expect(messageBodySource).toContain("diffScope: 'turn'");
    expect(messageBodySource).toContain("dedupeKey: `turn-diff:${diffSessionId || 'session'}:${turnId}`");
    expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId, diffSessionId)');
  });
});

describe('DiffView staged turn changes queries', () => {
  test('loads L2 on an opened turn scope and removes the whole-turn session diff path', () => {
    expect(diffViewSource).toContain('useSessionTurnChangesQuery');
    expect(diffViewSource).toContain("activeDiffScope === 'turn'");
    expect(diffViewSource).toContain('enabled: shouldLoadTurnChanges');
    expect(diffViewSource).not.toContain('getSessionDiff');
    expect(diffViewSource).not.toContain('mergeTurnDiffSummariesWithFull');
  });

  test('loads L3 only for an expanded mounted file row', () => {
    expect(diffViewSource).toContain('useSessionTurnChangeFileQuery');
    expect(diffViewSource).toContain('enabled: loadTurnChangeFile && Boolean(turnChangesRequest) && isExpanded && isMounted');
    expect(diffViewSource).toContain("loadTurnChangeFile={activeDiffScope === 'turn' && !usesToolPatches}");
  });

  test('short-circuits tool patches and protects turn scope from expand-all fanout', () => {
    expect(diffViewSource).toContain('if (usesToolPatches) return selectedToolTurnDiffs;');
    expect(diffViewSource).toContain("stackedDefaultCollapsedAll || (activeDiffScope === 'turn' && !usesToolPatches)");
    expect(diffViewSource).toContain("(activeDiffScope !== 'turn' || usesToolPatches)");
  });

  test('scopes turn diffs to the owning session instead of the global current session', () => {
    // Nested/subagent panels pass sessionId; blank/absent falls back to the primary session.
    expect(diffViewSource).toContain("const resolvedSessionId = (typeof sessionId === 'string' && sessionId.trim())");
    expect(diffViewSource).toContain('        ? sessionId.trim()');
    expect(diffViewSource).toContain('        : globalSessionId;');
    // Transcript scan and staged queries both use the resolved session.
    expect(diffViewSource).toContain("useSessionMessages(resolvedSessionId ?? ''");
    expect(diffViewSource).toContain('sessionID: resolvedSessionId,');
    // …while review stays attached to the primary chat session.
    expect(diffViewSource).toContain('originalSessionID: globalSessionId,');
    // Directory: explicit panel root wins over the primary effective directory.
    expect(diffViewSource).toContain('const effectiveDirectory = (typeof directory === \'string\' && directory.trim())');
  });
});

describe('DiffView per-file row action contract', () => {
  test('file rows jump to the file viewer instead of duplicating the layout toggle', () => {
    // Only the toolbar may render the global layout toggle.
    expect(diffViewSource.split('<DiffViewToggle').length - 1).toBe(1);
    // Per-file rows navigate to the file (preview state for previewable types).
    expect(diffViewSource).toContain('onOpenFile?: (filePath: string) => void');
    expect(diffViewSource).toContain('onOpenFile={openDiffFilePreview}');
    expect(diffViewSource).toContain('diffView.actions.openFilePreview');
    // Dedicated mobile routes through the mobile file sheet; desktop validates then opens.
    expect(diffViewSource).toContain('mobileActions.openFile({ path: absolutePath })');
    expect(diffViewSource).toContain('openContextFile(effectiveDirectory, absolutePath)');
  });
});
