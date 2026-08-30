import { describe, expect, test } from 'bun:test';

import {
    collectComposerMentionHighlights,
    collectConfirmableFileMentions,
    collectSessionMentionIds,
    findSessionMentionRanges,
    getFileMentionAutocompleteQuery,
    getSessionMentionToken,
    getVisibleSessionMentionCandidates,
    mergeAndRankFileMentionPathHits,
    rankAgentMentionCandidates,
    rankRecentFileMentionCandidates,
    replaceSessionMentionTokens,
    resolveSessionMentionDeletion,
    shouldHighlightFileMention,
} from '../fileMentionAutocompleteState';
import { buildSessionMentionInstruction, type SessionMentionContext } from '@/composer/delivery';
import type { Session } from '@opencode-ai/sdk/v2';

describe('getFileMentionAutocompleteQuery', () => {
    test('opens file mention autocomplete for manually typed boundary @ text', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'manual',
        })).toBe('config');

        expect(getFileMentionAutocompleteQuery({
            value: 'check @main.ts',
            cursorPosition: 'check @main.ts'.length,
            inputSource: 'manual',
        })).toBe('main.ts');

        expect(getFileMentionAutocompleteQuery({
            value: 'check @docs',
            cursorPosition: 'check @docs'.length,
        })).toBe('docs');
    });

    test('does not open file mention autocomplete when pasted text contains @', () => {
        const pastedValues = [
            '@config',
            '@/path/to/file',
            'Use @main.ts',
        ];

        for (const value of pastedValues) {
            expect(getFileMentionAutocompleteQuery({
                value,
                cursorPosition: value.length,
                inputSource: 'paste',
                insertedText: value,
            })).toBeNull();
        }
    });

    test('does not open file mention autocomplete for pasted package and email text', () => {
        const pastedValues = [
            'user@email.com',
            'npx @scope/pkg@latest',
        ];

        for (const value of pastedValues) {
            expect(getFileMentionAutocompleteQuery({
                value,
                cursorPosition: value.length,
                inputSource: 'paste',
                insertedText: value,
            })).toBeNull();
        }
    });

    test('keeps autocomplete open when pasting a query fragment after a manually typed @', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'paste',
            insertedText: 'config',
        })).toBe('config');
    });

    test('uses current value when paste source lacks inserted text context', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'paste',
        })).toBe('config');
    });
});

describe('session mentions', () => {
    test('searches every loaded global session while the empty menu stays bounded', () => {
        const sessions = [
            { id: 'ses_1', title: 'Alpha', time: { created: 1, updated: 1 } },
            { id: 'ses_2', title: 'Beta', time: { created: 2, updated: 2 } },
            { id: 'ses_3', title: 'Gamma', time: { created: 3, updated: 3 } },
            { id: 'ses_4', title: 'Delta', time: { created: 4, updated: 4 } },
        ] as Session[];

        expect(getVisibleSessionMentionCandidates({
            sessions,
            currentSessionId: null,
            searchQuery: '',
        }).map((session) => session.id)).toEqual(['ses_4', 'ses_3', 'ses_2']);

        expect(getVisibleSessionMentionCandidates({
            sessions,
            currentSessionId: null,
            searchQuery: 'a',
        }).map((session) => session.id)).toEqual(['ses_4', 'ses_3', 'ses_2', 'ses_1']);
    });

    test('creates stable tokens and collects unique session IDs in message order', () => {
        expect(getSessionMentionToken('ses_123')).toBe('session:ses_123');
        expect(collectSessionMentionIds('Compare @session:ses_123 with @session:ses_456 and @session:ses_123.')).toEqual([
            'ses_123',
            'ses_456',
        ]);
        expect(collectSessionMentionIds('email@session:ses_123')).toEqual([]);
        expect(findSessionMentionRanges('Use (@session:ses_123)')).toEqual([
            { start: 5, end: 21, id: 'ses_123' },
        ]);
    });

    test('renders readable labels and deletes a session tag atomically', () => {
        const text = 'Compare @session:ses_123 with this';
        expect(replaceSessionMentionTokens(text, new Map([['ses_123', 'Previous implementation']]))).toBe(
            'Compare @Previous implementation with this',
        );
        expect(resolveSessionMentionDeletion(text, 'Backspace', 20, 20)).toEqual({
            text: 'Compare with this',
            caret: 8,
        });
        expect(resolveSessionMentionDeletion(text, 'Delete', 8, 8)).toEqual({
            text: 'Compare with this',
            caret: 8,
        });
    });

    test('builds session references with directory and cached messages', () => {
        const instruction = buildSessionMentionInstruction([
            {
                id: 'ses_123',
                title: 'Previous implementation',
                directory: '/project',
                messages: [{ role: 'user', text: 'Implement grouped mentions' }],
            },
        ]);

        expect(instruction).toContain('ses_123');
        expect(instruction).toContain('Implement grouped mentions');
        expect(instruction).toContain('/project');
        expect(instruction).toContain('sqlite3');
        expect(buildSessionMentionInstruction([], 100)).toBeNull();
        const boundedInstruction = buildSessionMentionInstruction([
            { id: 'ses_123', title: 'Long', directory: '/p', messages: [{ role: 'user', text: 'x'.repeat(5_000) }] },
            { id: 'ses_456', title: 'Second', directory: '/p', messages: [{ role: 'assistant', text: 'y'.repeat(5_000) }] },
        ], 4_000);
        expect((boundedInstruction?.length ?? 0) <= 4_000).toBe(true);
        const payload = boundedInstruction?.slice((boundedInstruction.indexOf('\n') ?? -1) + 1) ?? '';
        const parsed = JSON.parse(payload) as SessionMentionContext[];
        expect(parsed.map((context) => context.id)).toEqual(['ses_123', 'ses_456']);
        expect(parsed[0].messages[0]?.text).toContain('[Message truncated]');
    });
});

describe('rankRecentFileMentionCandidates', () => {
    test('uses fileMentionSearch so a basename match beats a mid-path include', () => {
        const ranked = rankRecentFileMentionCandidates([
            { relativePath: 'packages/search-utils/readme.md', name: 'readme.md' },
            { relativePath: 'src/search.ts', name: 'search.ts', extension: 'ts' },
            { relativePath: 'docs/unrelated.md', name: 'unrelated.md' },
        ], 'search.ts', { limit: 6 });

        expect(ranked.map((item) => item.relativePath)).toEqual([
            'src/search.ts',
            'packages/search-utils/readme.md',
        ]);
    });
});

describe('rankAgentMentionCandidates', () => {
    test('drops unmatched agents and ranks exact name ahead of a description hit', () => {
        const ranked = rankAgentMentionCandidates([
            { name: 'explore', description: 'look around' },
            { name: 'build', description: 'compile search hits' },
            { name: 'search', description: 'find files' },
        ], 'search');

        expect(ranked.map((agent) => agent.name)).toEqual(['search', 'build']);
    });
});

describe('mergeAndRankFileMentionPathHits', () => {
    const hit = (relativePath: string, extras?: { isDirectory?: boolean; path?: string }) => {
        const name = relativePath.split('/').filter(Boolean).pop() || relativePath;
        return {
            name,
            path: extras?.path ?? `/project/${relativePath}`,
            relativePath,
            extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
            isDirectory: extras?.isDirectory,
        };
    };

    test('interleaves files and directories by similarity without group-by kind', () => {
        const ranked = mergeAndRankFileMentionPathHits({
            files: [
                hit('packages/ui/src/config.ts'),
                hit('docs/config.md'),
            ],
            directories: [
                hit('config', { isDirectory: true }),
                hit('packages/config', { isDirectory: true }),
            ],
            query: 'config',
            limit: 10,
        });

        // Exact name "config" wins for both the root dir and packages/config;
        // file hits follow by path/name tier — never folders-first then files.
        expect(ranked.map((item) => item.relativePath)).toEqual([
            'config',
            'packages/config',
            'docs/config.md',
            'packages/ui/src/config.ts',
        ]);
        expect(ranked.map((item) => Boolean(item.isDirectory))).toEqual([
            true,
            true,
            false,
            false,
        ]);
        // Critical: a mid-score file is not forced after every directory.
        // packages/config (dir) is only ahead of docs/config.md because its
        // basename matches exactly, not because of kind grouping.
    });

    test('keeps a better-matching file ahead of a weaker directory hit', () => {
        const ranked = mergeAndRankFileMentionPathHits({
            files: [hit('src/search.ts')],
            directories: [hit('packages/search-utils', { isDirectory: true })],
            query: 'search.ts',
        });

        expect(ranked.map((item) => item.relativePath)).toEqual([
            'src/search.ts',
            'packages/search-utils',
        ]);
        expect(ranked[0]?.isDirectory).toBeFalsy();
    });

    test('excludes recent paths and preserves directory mime flag', () => {
        const ranked = mergeAndRankFileMentionPathHits({
            files: [hit('src/a.ts'), hit('src/b.ts')],
            directories: [hit('src', { isDirectory: true })],
            query: 'src',
            excludePaths: new Set(['/project/src/a.ts']),
        });

        expect(ranked.map((item) => item.path)).not.toContain('/project/src/a.ts');
        expect(ranked.find((item) => item.relativePath === 'src')?.isDirectory).toBe(true);
    });
});

describe('file mention confirmation', () => {
    test('does not highlight an in-progress typed path until space terminates it', () => {
        expect(shouldHighlightFileMention({
            mention: 'yi.ts',
            confirmed: false,
            terminated: false,
        })).toBe(false);
        expect(collectComposerMentionHighlights('@yi.ts', {
            confirmedValues: new Set(),
            agentNames: new Set(),
        })).toEqual([]);
        expect(collectComposerMentionHighlights('see @src/yi.ts', {
            confirmedValues: new Set(),
            agentNames: new Set(),
        })).toEqual([]);
        expect(collectComposerMentionHighlights('user@email.com', {
            confirmedValues: new Set(),
            agentNames: new Set(),
        })).toEqual([]);
    });

    test('highlights a path-like mention after space or a confirmed autocomplete pick', () => {
        expect(shouldHighlightFileMention({
            mention: 'yi.ts',
            confirmed: false,
            terminated: true,
        })).toBe(true);
        expect(collectComposerMentionHighlights('@yi.ts please', {
            confirmedValues: new Set(),
            agentNames: new Set(),
        })).toEqual([{ start: 0, end: 6, kind: 'file' }]);
        expect(collectComposerMentionHighlights('@src/yi.ts', {
            confirmedValues: new Set(['src/yi.ts']),
            agentNames: new Set(),
        })).toEqual([{ start: 0, end: 10, kind: 'file' }]);
    });

    test('does not treat an in-progress mention as atomically deletable', () => {
        expect(shouldHighlightFileMention({
            mention: 'src/yi.ts',
            confirmed: false,
            terminated: false,
        })).toBe(false);
        expect(shouldHighlightFileMention({
            mention: 'src/yi.ts',
            confirmed: true,
            terminated: false,
        })).toBe(true);
    });

    test('confirms terminated path mentions and pasted file references', () => {
        expect(collectConfirmableFileMentions('@yi.ts')).toEqual([]);
        expect(collectConfirmableFileMentions('@yi.ts\nnext')).toEqual([
            { kind: 'file', value: 'yi.ts', start: 0, end: 6 },
        ]);
        expect(collectConfirmableFileMentions('see @src/yi.ts ', {
            agentNames: new Set(['build']),
        })).toEqual([
            { kind: 'file', value: 'src/yi.ts', start: 4, end: 14 },
        ]);
        expect(collectConfirmableFileMentions('@src/yi.ts', {
            includeUnterminatedPastedReferences: true,
        })).toEqual([
            { kind: 'file', value: 'src/yi.ts', start: 0, end: 10 },
        ]);
        expect(collectConfirmableFileMentions('@scope/pkg@latest', {
            includeUnterminatedPastedReferences: true,
        })).toEqual([]);
        expect(collectConfirmableFileMentions('ask @build about @src/a.ts ', {
            agentNames: new Set(['build']),
        })).toEqual([
            { kind: 'file', value: 'src/a.ts', start: 17, end: 26 },
        ]);
    });
});
