import { parsePatchFiles } from '@pierre/diffs';

export type DiffPatchEntry = {
    id: string;
    title: string;
    patch: string;
    renderMode: 'diff' | 'text';
};

const APPLY_PATCH_ENVELOPE_PATTERN = /^\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/m;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;
const GIT_DIFF_FILE_BREAK_PATTERN = /(?=^diff --git\s+)/gm;
const GIT_DIFF_FILE_BREAK_TEST = /^diff --git\s+/m;
const UNIFIED_DIFF_FILE_BREAK_PATTERN = /(?=^---\s+\S)/gm;
const UNIFIED_DIFF_FILE_BREAK_TEST = /^---\s+\S/m;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const normalizePatchText = (patch: string): string => {
    return patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

const normalizeBareUnifiedHeaderLines = (patch: string): string => {
    let reachedHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            reachedHunk = true;
            return line;
        }

        if (reachedHunk) {
            return line;
        }

        const headerMatch = line.match(/^\s*(---|\+\+\+)\s+(.+)$/);
        if (!headerMatch) {
            return line;
        }

        const marker = headerMatch[1];
        const rawPath = headerMatch[2] ?? '';
        if (rawPath.trim() === '/dev/null') {
            return `${marker} /dev/null`;
        }

        return `${marker} ${rawPath.replace(/\\/g, '/')}`;
    }).join('\n');
};

const normalizeLooseUnifiedHunkBody = (patch: string): string => {
    let inHunk = false;
    return patch.split('\n').map((line) => {
        if (line.startsWith('@@')) {
            inHunk = true;
            return line;
        }

        if (!inHunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git')) {
            return line;
        }

        if (line.length === 0) {
            return ' ';
        }

        const first = line[0];
        if (first === ' ' || first === '+' || first === '-' || first === '\\') {
            return line;
        }

        return ` ${line}`;
    }).join('\n');
};

const formatHunkRange = (start: string, count: number): string => {
    return count === 1 ? start : `${start},${count}`;
};

const recountUnifiedHunkHeaders = (patch: string): string => {
    const lines = patch.split('\n');
    const result = [...lines];

    for (let index = 0; index < lines.length; index += 1) {
        const header = lines[index] ?? '';
        const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (!match) {
            continue;
        }

        let oldCount = 0;
        let newCount = 0;
        for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
            const line = lines[bodyIndex] ?? '';
            if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('diff --git')) {
                break;
            }

            if (line.startsWith('\\')) {
                continue;
            }

            if (line.startsWith('+')) {
                newCount += 1;
                continue;
            }

            if (line.startsWith('-')) {
                oldCount += 1;
                continue;
            }

            oldCount += 1;
            newCount += 1;
        }

        result[index] = `@@ -${formatHunkRange(match[1] ?? '0', oldCount)} +${formatHunkRange(match[2] ?? '0', newCount)} @@${match[3] ?? ''}`;
    }

    return result.join('\n');
};

const normalizeLooseUnifiedPatch = (patch: string): string => {
    return recountUnifiedHunkHeaders(normalizeLooseUnifiedHunkBody(normalizeBareUnifiedHeaderLines(normalizePatchText(patch))));
};

export const getPatchText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        return /\S/.test(value) ? value : undefined;
    }

    if (isRecord(value)) {
        const patch = value.patch;
        if (typeof patch === 'string') {
            return /\S/.test(patch) ? patch : undefined;
        }
    }

    return undefined;
};

const normalizeParsedPath = (path: string | undefined): string => {
    const trimmed = (path ?? '').trim().replace(/\t.*$/, '');
    if (!trimmed || trimmed === '/dev/null') {
        return '';
    }
    return trimmed.replace(/^[ab]\//, '');
};

const makeSyntheticPath = (title: string): string => {
    const normalized = title.trim().replace(/\s+/g, '-');
    return normalized.length > 0 ? normalized : 'file';
};

const hasOnlyUnifiedDiffBodyLines = (patch: string): boolean => {
    let inHunk = false;
    for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
            if (!HUNK_HEADER_PATTERN.test(line)) {
                return false;
            }
            inHunk = true;
            continue;
        }

        if (!inHunk || line.length === 0) {
            continue;
        }

        const first = line[0];
        if (first !== ' ' && first !== '+' && first !== '-' && first !== '\\') {
            return false;
        }
    }

    return true;
};

export const getRenderablePatchInfo = (patch: string): { patch: string; title?: string } | null => {
    const normalized = normalizeLooseUnifiedPatch(patch);
    if (
        !normalized
        || APPLY_PATCH_ENVELOPE_PATTERN.test(normalized)
        || !HUNK_HEADER_PATTERN.test(normalized)
        || !hasOnlyUnifiedDiffBodyLines(normalized)
    ) {
        return null;
    }

    try {
        const parsedPatches = parsePatchFiles(normalized, undefined, true);
        if (parsedPatches.length !== 1) {
            return null;
        }

        const files = parsedPatches[0]?.files ?? [];
        const file = files[0];
        if (files.length !== 1 || !file || file.hunks.length === 0) {
            return null;
        }

        return {
            patch: normalized,
            title: normalizeParsedPath(file.name),
        };
    } catch {
        return null;
    }
};

const getPatchChunks = (patch: string): string[] => {
    const isGitDiff = GIT_DIFF_FILE_BREAK_TEST.test(patch);
    const hasUnifiedDiff = UNIFIED_DIFF_FILE_BREAK_TEST.test(patch);
    if (!isGitDiff && !hasUnifiedDiff) {
        return [];
    }

    return patch
        .split(isGitDiff ? GIT_DIFF_FILE_BREAK_PATTERN : UNIFIED_DIFF_FILE_BREAK_PATTERN)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
};

const getPatchEntriesFromText = (
    patch: string,
    fallbackTitle: string,
    idPrefix: string,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const normalized = normalizeLooseUnifiedPatch(patch);
    if (!normalized) {
        return [];
    }

    const direct = getRenderablePatchInfo(normalized);
    if (direct) {
        const title = direct.title ? resolveTitle(direct.title) : resolveTitle(fallbackTitle);
        return [{ id: `${idPrefix}-0`, title, patch: direct.patch, renderMode: 'diff' }];
    }

    const chunkEntries: DiffPatchEntry[] = [];
    for (const chunk of getPatchChunks(normalized)) {
        const info = getRenderablePatchInfo(chunk);
        const title = info?.title ? resolveTitle(info.title) : resolveTitle(fallbackTitle);
        if (!info) {
            if (HUNK_HEADER_PATTERN.test(chunk) || GIT_DIFF_FILE_BREAK_TEST.test(chunk) || UNIFIED_DIFF_FILE_BREAK_TEST.test(chunk)) {
                chunkEntries.push({
                    id: `${idPrefix}-${chunkEntries.length}`,
                    title,
                    patch: chunk,
                    renderMode: 'text',
                });
            }
            continue;
        }
        chunkEntries.push({
            id: `${idPrefix}-${chunkEntries.length}`,
            title,
            patch: info.patch,
            renderMode: 'diff',
        });
    }

    if (chunkEntries.length > 0) {
        return chunkEntries;
    }

    if (!APPLY_PATCH_ENVELOPE_PATTERN.test(normalized) && HUNK_HEADER_PATTERN.test(normalized)) {
        const syntheticPath = makeSyntheticPath(fallbackTitle);
        const synthetic = getRenderablePatchInfo(`--- ${syntheticPath}\n+++ ${syntheticPath}\n${normalized}`);
        if (synthetic) {
            return [{
                id: `${idPrefix}-0`,
                title: resolveTitle(fallbackTitle),
                patch: synthetic.patch,
                renderMode: 'diff',
            }];
        }
    }

    return [{
        id: `${idPrefix}-0`,
        title: resolveTitle(fallbackTitle),
        patch: normalized,
        renderMode: 'text',
    }];
};

const getFilePatch = (file: unknown): { patch: string; title: string } | null => {
    if (!isRecord(file)) {
        return null;
    }

    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    if (!patch) {
        return null;
    }

    const rawPath = typeof file.movePath === 'string'
        ? file.movePath
        : typeof file.relativePath === 'string'
            ? file.relativePath
            : typeof file.filePath === 'string'
                ? file.filePath
                : '';

    return {
        patch,
        title: rawPath,
    };
};

export const getDiffPatchEntries = (
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string | undefined,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const fileEntries = files.flatMap((file, index) => {
        const filePatch = getFilePatch(file);
        if (!filePatch) {
            return [];
        }
        return getPatchEntriesFromText(
            filePatch.patch,
            filePatch.title || `File ${index + 1}`,
            `file-${index}`,
            resolveTitle,
        );
    });

    if (fileEntries.length > 0) {
        return fileEntries;
    }

    const diff = typeof fallbackDiff === 'string' ? fallbackDiff : '';
    return getPatchEntriesFromText(diff, 'Diff', 'fallback', resolveTitle);
};

const normalizeComparablePath = (value: string): string =>
    value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');

export const getToolNavigationDiffEntries = (
    toolName: string,
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string | undefined,
    preferredPath: string,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const entries = getDiffPatchEntries(metadata, fallbackDiff, resolveTitle);
    if (entries.length === 0 || entries.some((entry) => entry.renderMode !== 'diff')) {
        return [];
    }

    const metadataFiles = Array.isArray(metadata?.files) ? metadata.files : [];
    if (toolName === 'apply_patch') {
        if (metadataFiles.length > 0) {
            const patchBearingFileCount = metadataFiles.reduce((count, file) => (
                getFilePatch(file) ? count + 1 : count
            ), 0);
            if (patchBearingFileCount > 0 && patchBearingFileCount !== metadataFiles.length) {
                return [];
            }
        }
        const uniquePaths = new Set(entries.map((entry) => normalizeComparablePath(entry.title)));
        if (uniquePaths.size !== entries.length) {
            return [];
        }
        return entries;
    }

    const normalizedPreferredPath = normalizeComparablePath(preferredPath);
    const selected = entries.find((entry) => (
        normalizeComparablePath(entry.title) === normalizedPreferredPath
    )) ?? entries[0];
    return selected ? [selected] : [];
};

export type LineDiffTotals = {
    added: number;
    removed: number;
};

const parseDiffCount = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return Math.max(0, parsed);
        }
    }
    return null;
};

const countUnifiedDiffLines = (diffText: string): LineDiffTotals => {
    let added = 0;
    let removed = 0;
    let lineStart = 0;

    for (let index = 0; index <= diffText.length; index += 1) {
        if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
            continue;
        }

        const line = diffText.slice(lineStart, index);
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
        if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
        lineStart = index + 1;
    }

    return { added, removed };
};

const countWriteContentLines = (input: Record<string, unknown> | undefined): number => {
    if (!input?.content || typeof input.content !== 'string') {
        return 0;
    }
    let lines = 1;
    for (let index = 0; index < input.content.length; index += 1) {
        if (input.content.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

const readToolPartState = (part: unknown): {
    metadata?: Record<string, unknown>;
    input?: Record<string, unknown>;
} => {
    if (!isRecord(part)) {
        return {};
    }
    const state = isRecord(part.state) ? part.state : {};
    const metadata = isRecord(state.metadata)
        ? state.metadata
        : isRecord(part.metadata)
            ? part.metadata
            : undefined;
    const input = isRecord(state.input) ? state.input : undefined;
    return { metadata, input };
};

/** Line totals for one tool part: metadata, per-file stats, patch body, or write content. */
export const getToolPartLineDiffTotals = (part: unknown): LineDiffTotals => {
    const { metadata, input } = readToolPartState(part);
    const addedFromMeta = parseDiffCount(metadata?.additions);
    const removedFromMeta = parseDiffCount(metadata?.deletions);
    if (addedFromMeta !== null || removedFromMeta !== null) {
        return { added: addedFromMeta ?? 0, removed: removedFromMeta ?? 0 };
    }

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    let fileAdded = 0;
    let fileRemoved = 0;
    let fileHasCounts = false;
    for (const file of files) {
        if (!isRecord(file)) continue;
        const added = parseDiffCount(file.additions);
        const removed = parseDiffCount(file.deletions);
        if (added === null && removed === null) continue;
        fileHasCounts = true;
        fileAdded += added ?? 0;
        fileRemoved += removed ?? 0;
    }
    if (fileHasCounts) {
        return { added: fileAdded, removed: fileRemoved };
    }

    const patch = getPatchText(metadata?.patch) ?? getPatchText(metadata?.diff);
    if (patch) {
        const counts = countUnifiedDiffLines(patch);
        if (counts.added > 0 || counts.removed > 0) {
            return counts;
        }
    }

    const writeLines = countWriteContentLines(input);
    if (writeLines > 0) {
        return { added: writeLines, removed: 0 };
    }

    return { added: 0, removed: 0 };
};

export const aggregateToolPartLineDiffTotals = (parts: readonly unknown[]): LineDiffTotals => {
    let added = 0;
    let removed = 0;
    for (const part of parts) {
        const totals = getToolPartLineDiffTotals(part);
        added += totals.added;
        removed += totals.removed;
    }
    return { added, removed };
};
