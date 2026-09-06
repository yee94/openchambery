import { describe, expect, test } from 'bun:test';

import { aggregateToolPartLineDiffTotals, getDiffPatchEntries, getRenderablePatchInfo, getToolNavigationDiffEntries, getToolPartLineDiffTotals } from './toolDiffUtils';

const identity = (path: string) => path;

describe('toolDiffUtils', () => {
    test('treats raw apply_patch envelopes as text, not visual diffs', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Update File: src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('*** Begin Patch');
    });

    test('splits multi-file unified patches into one renderable entry per file', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1 +1 @@',
            '-left',
            '+right',
        ].join('\n'), identity);

        expect(entries.map((entry) => entry.renderMode)).toEqual(['diff', 'diff']);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('uses metadata.files patches before top-level fallback diffs', () => {
        const entries = getDiffPatchEntries({
            files: [{
                relativePath: 'src/file.ts',
                patch: [
                    '--- a/src/file.ts',
                    '+++ b/src/file.ts',
                    '@@ -1 +1 @@',
                    '-old',
                    '+new',
                ].join('\n'),
            }],
        }, 'not a diff', identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/file.ts');
    });

    test('synthesizes headers for valid headerless hunks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(getRenderablePatchInfo(entries[0]?.patch ?? '')).not.toBeNull();
    });

    test('keeps malformed unified patches as text fallbacks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('@@');
    });

    test('keeps every file from one apply_patch call for Changes navigation', () => {
        const metadata = {
            files: [
                {
                    relativePath: 'src/a.ts',
                    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
                },
                {
                    relativePath: 'src/b.ts',
                    patch: '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-left\n+right',
                },
            ],
        };

        const entries = getToolNavigationDiffEntries(
            'apply_patch',
            metadata,
            undefined,
            'src/a.ts',
            identity,
        );

        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('keeps every file from a top-level multi-file apply_patch diff', () => {
        const entries = getToolNavigationDiffEntries(
            'apply_patch',
            undefined,
            [
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '--- a/src/b.ts',
                '+++ b/src/b.ts',
                '@@ -1 +1 @@',
                '-left',
                '+right',
            ].join('\n'),
            'src/a.ts',
            identity,
        );

        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('treats a write-style added-file patch as a navigable single-file diff', () => {
        const patch = [
            '--- /dev/null',
            '+++ b/app/service/__typeprobe.ts',
            '@@ -0,0 +1,3 @@',
            '+line one',
            '+line two',
            '+line three',
        ].join('\n');

        const entries = getToolNavigationDiffEntries(
            'write',
            undefined,
            patch,
            'app/service/__typeprobe.ts',
            identity,
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('app/service/__typeprobe.ts');
        expect(entries[0]?.patch).toContain('--- /dev/null');
        expect(entries[0]?.patch).toContain('+line one');
    });

    test('keeps edit navigation scoped to its selected file', () => {
        const metadata = {
            files: [
                {
                    relativePath: 'src/a.ts',
                    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
                },
                {
                    relativePath: 'src/b.ts',
                    patch: '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-left\n+right',
                },
            ],
        };

        const entries = getToolNavigationDiffEntries(
            'edit',
            metadata,
            undefined,
            'src/b.ts',
            identity,
        );

        expect(entries.map((entry) => entry.title)).toEqual(['src/b.ts']);
    });

    test('falls back as a complete turn when one apply_patch file cannot render', () => {
        const entries = getToolNavigationDiffEntries(
            'apply_patch',
            {
                files: [
                    {
                        relativePath: 'src/a.ts',
                        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
                    },
                    {
                        relativePath: 'src/b.ts',
                        patch: 'malformed patch',
                    },
                ],
            },
            undefined,
            'src/a.ts',
            identity,
        );

        expect(entries).toEqual([]);
    });

    test('reads line totals from metadata, files, patch text, and write content', () => {
        expect(getToolPartLineDiffTotals({
            state: { metadata: { additions: '4', deletions: 2 } },
        })).toEqual({ added: 4, removed: 2 });

        expect(getToolPartLineDiffTotals({
            state: { metadata: { files: [{ additions: 1, deletions: 3 }, { additions: 2 }] } },
        })).toEqual({ added: 3, removed: 3 });

        expect(getToolPartLineDiffTotals({
            state: { metadata: { patch: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n' } },
        })).toEqual({ added: 1, removed: 1 });

        expect(getToolPartLineDiffTotals({
            state: { input: { content: 'alpha\nbeta' } },
        })).toEqual({ added: 2, removed: 0 });

        expect(aggregateToolPartLineDiffTotals([
            { state: { metadata: { additions: 1, deletions: 1 } } },
            { state: { input: { content: 'only' } } },
        ])).toEqual({ added: 2, removed: 1 });
    });
});
