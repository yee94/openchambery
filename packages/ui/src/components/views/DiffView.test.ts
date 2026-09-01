import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createToolPatchTurnDiffs,
  getFirstChangedModifiedLineFromPatch,
} from './diffPatchUtils';
import {
  buildDiffNavigationAlignKey,
  shouldAlignDiffNavigation,
} from './diffNavigationAlign';
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

  test('keeps thin summary diffs compatible', () => {
    expect(projectTurnDiffStats(userMessage({
      diffs: [{ file: 'a.ts', additions: 2, deletions: 1 }],
    }))).toEqual({ additions: 2, deletions: 1, files: 1, hasDiffs: true });
  });

  test('prefers diffCount when thin diffs and markers are both present', () => {
    expect(projectTurnDiffStats(userMessage({
      diffs: [{ file: 'a.ts', additions: 2, deletions: 1 }],
      diffCount: 3,
      hasDiffs: true,
    }))).toEqual({ additions: 2, deletions: 1, files: 3, hasDiffs: true });
  });
});

describe('Turn Changes preview contract', () => {
  test('renders inline file rows from the L1 thin list on the wire', () => {
    expect(messageBodySource).toContain('fileCount={turnGroupingContext.diffStats.files}');
    expect(messageBodySource).toContain('changedFiles={turnGroupingContext.changedFiles}');
    // The thin list rides the message wire; there is no async list load.
    expect(messageBodySource).not.toContain('useSessionTurnChangesQuery');
    expect(messageBodySource).toContain('data-turn-change-file="true"');
    expect(messageBodySource).toContain('TURN_CHANGES_PREVIEW_VISIBLE_LIMIT');
    expect(messageBodySource).toContain("mode: 'diff'");
    expect(messageBodySource).toContain("diffScope: 'turn'");
    expect(messageBodySource).toContain("dedupeKey: `turn-diff:${diffSessionId || 'session'}:${turnId}`");
    expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId, diffSessionId, file)');
    expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId, diffSessionId)');
    expect(messageBodySource).toContain('openTurnChangedFilePreview');
  });
});

describe('DiffView staged turn changes queries', () => {
  test('renders turn file rows from sync thin diffs without any list request', () => {
    expect(diffViewSource).toContain('const thinDiffs = listTurnDiffs(message.summary?.diffs);');
    expect(diffViewSource).toContain('return turnChangesMarker.thinDiffs;');
    // No async list query for turn scope — the L1 thin list is authoritative.
    expect(diffViewSource).not.toContain('useSessionTurnChangesQuery');
    expect(diffViewSource).not.toContain('getSessionDiff');
    expect(diffViewSource).not.toContain('mergeTurnDiffSummariesWithFull');
  });

  test('loads L3 only for an expanded mounted file row', () => {
    expect(diffViewSource).toContain('useSessionTurnChangeFileQuery');
    expect(diffViewSource).toContain('enabled: loadTurnChangeFile && Boolean(turnChangesRequest) && isExpanded && isMounted');
    expect(diffViewSource).toContain("loadTurnChangeFile={activeDiffScope === 'turn' && !usesToolPatches}");
    // A failed L3 refresh must not cover an already-rendered snapshot.
    expect(diffViewSource).toContain('const visibleDiffLoadError = diffData');
  });

  test('single-file tool patches still match when the parsed path keeps a workspace prefix', () => {
    expect(diffViewSource).toContain('const isSameDiffFilePath = (left?: string | null, right?: string | null): boolean => {');
    expect(diffViewSource).toContain('return changedFiles.filter((file) => isSameDiffFilePath(file.path, selectedPath));');
    expect(diffViewSource).toContain('|| (singleFileView && visibleDiffFiles.length === 1)');
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

describe('DiffView navigation align', () => {
  test('pins once per navigation identity, not on later file-list refreshes', () => {
    const key = buildDiffNavigationAlignKey({
      scope: 'turn',
      navigationRequestKey: 12,
      targetFilePath: 'src/a.ts',
      targetLine: 40,
    });
    expect(shouldAlignDiffNavigation(null, key, true)).toBe(true);
    expect(shouldAlignDiffNavigation(key, key, true)).toBe(false);
    expect(shouldAlignDiffNavigation(key, key, false)).toBe(false);
    expect(shouldAlignDiffNavigation(
      key,
      buildDiffNavigationAlignKey({
        scope: 'turn',
        navigationRequestKey: 13,
        targetFilePath: 'src/a.ts',
        targetLine: 40,
      }),
      true,
    )).toBe(true);
  });

  test('waits for the target row before the first pin', () => {
    const key = buildDiffNavigationAlignKey({
      scope: 'working',
      navigationRequestKey: 1,
      targetFilePath: 'src/a.ts',
    });
    expect(shouldAlignDiffNavigation(null, key, false)).toBe(false);
    expect(shouldAlignDiffNavigation(null, key, true)).toBe(true);
  });

  test('keeps a rendered git snapshot while status refreshes', () => {
    expect(diffViewSource).toContain('const keepVisibleSnapshot = Boolean(diffData && diffDataMatchesContextMode)');
    expect(diffViewSource).toContain('lastAlignedNavigationKeyRef');
    expect(diffViewSource).not.toContain('setLocalDiffData(null)');
  });
});

describe('DiffView empty full-context load contract', () => {
  test('does not treat dual-empty non-binary cache as loaded full context', () => {
    // Helper rejects empty before/after unless binary/patch/fileDiff is present.
    expect(diffViewSource).toContain('const hasLoadedFullContextBody');
    expect(diffViewSource).toContain('if (!hasLoadedFullContextBody(fromCache)) return null;');
    // Turn L3 and thin turn maps use the same empty-body guard.
    expect(diffViewSource).toContain('Only seed before/after when a real body is present');
    // Successful full fetch always seeds localDiffData so a true empty file cannot
    // re-enter on-demand fetch via a dual-empty cache entry alone.
    expect(diffViewSource).toContain('setLocalDiffData(nextDiff);');
    expect(diffViewSource).toContain('setDiff(directory, file.path, nextDiff);');
  });
});
