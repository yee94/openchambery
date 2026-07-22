import { describe, expect, test } from 'bun:test';
import type { ComposerDocument } from './document';
import {
    createComposerReferenceHistorySnapshot,
    emptyComposerReferenceHistory,
    pushComposerReferenceHistory,
    redoComposerReferenceHistory,
    undoComposerReferenceHistory,
} from './reference-history';

describe('Composer reference history', () => {
    test('restores every reference kind from one atomic snapshot', () => {
        const before: ComposerDocument = {
            text: '@A [Paste 1] /review /run @README.md',
            references: [
                { id: 'session', kind: 'session', sessionId: 'session-a', display: '@A', start: 0, end: 2 },
                { id: 'paste', kind: 'paste', text: 'paste payload', characterCount: 13, index: 1, display: '[Paste 1]', start: 3, end: 12 },
                { id: 'skill', kind: 'skill', skillName: 'review', display: '/review', start: 13, end: 20 },
                { id: 'command', kind: 'command', commandName: 'run', reference: 'run', display: '/run', start: 21, end: 25 },
            ],
        };
        const mentions = [{ kind: 'file' as const, value: 'README.md', path: '/README.md', label: 'README.md', range: { start: 26, end: 36 } }];
        const after: ComposerDocument = { text: '', references: [] };
        const entry = {
            before: createComposerReferenceHistorySnapshot(before, mentions, { start: 3, end: 20 }),
            after: createComposerReferenceHistorySnapshot(after, [], { start: 0, end: 0 }),
        };
        const recorded = pushComposerReferenceHistory(emptyComposerReferenceHistory(), entry);

        const undone = undoComposerReferenceHistory(recorded, after);
        expect(undone?.snapshot).toEqual(entry.before);
        expect(undone?.snapshot.document.references.map((reference) => reference.kind)).toEqual(['session', 'paste', 'skill', 'command']);

        const redone = undone && redoComposerReferenceHistory(undone.history, before);
        expect(redone?.snapshot).toEqual(entry.after);
    });

    test('keeps history scoped to its exact current document', () => {
        const before: ComposerDocument = { text: '[Paste 1]', references: [{ id: 'paste', kind: 'paste', text: 'payload', characterCount: 7, index: 1, display: '[Paste 1]', start: 0, end: 9 }] };
        const after: ComposerDocument = { text: '', references: [] };
        const history = pushComposerReferenceHistory(emptyComposerReferenceHistory(), {
            before: createComposerReferenceHistorySnapshot(before, [], { start: 0, end: 9 }),
            after: createComposerReferenceHistorySnapshot(after, [], { start: 0, end: 0 }),
        });

        expect(undoComposerReferenceHistory(history, { text: 'changed', references: [] })).toBe(null);
    });
});
