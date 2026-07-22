import type { DraftMention } from '@/sync/input-draft-types';
import type { ComposerDocument } from './document';

export interface ComposerReferenceHistorySnapshot {
    document: ComposerDocument;
    mentions: DraftMention[];
    selection: { start: number; end: number };
}

export interface ComposerReferenceHistoryEntry {
    before: ComposerReferenceHistorySnapshot;
    after: ComposerReferenceHistorySnapshot;
}

export interface ComposerReferenceHistoryState {
    undo: ComposerReferenceHistoryEntry[];
    redo: ComposerReferenceHistoryEntry[];
}

export const COMPOSER_REFERENCE_HISTORY_LIMIT = 100;

const cloneDocument = (document: ComposerDocument): ComposerDocument => ({
    text: document.text,
    references: document.references.map((reference) => ({ ...reference })),
});

const cloneMentions = (mentions: readonly DraftMention[]): DraftMention[] => (
    mentions.map((mention) => ({ ...mention, range: { ...mention.range } }))
);

const sameDocument = (left: ComposerDocument, right: ComposerDocument): boolean => (
    left.text === right.text && JSON.stringify(left.references) === JSON.stringify(right.references)
);

export const createComposerReferenceHistorySnapshot = (
    document: ComposerDocument,
    mentions: readonly DraftMention[],
    selection: { start: number; end: number },
): ComposerReferenceHistorySnapshot => ({
    document: cloneDocument(document),
    mentions: cloneMentions(mentions),
    selection: { ...selection },
});

export const emptyComposerReferenceHistory = (): ComposerReferenceHistoryState => ({ undo: [], redo: [] });

export const pushComposerReferenceHistory = (
    history: ComposerReferenceHistoryState,
    entry: ComposerReferenceHistoryEntry,
): ComposerReferenceHistoryState => ({
    undo: [...history.undo, entry].slice(-COMPOSER_REFERENCE_HISTORY_LIMIT),
    redo: [],
});

export const undoComposerReferenceHistory = (
    history: ComposerReferenceHistoryState,
    current: ComposerDocument,
): { history: ComposerReferenceHistoryState; snapshot: ComposerReferenceHistorySnapshot } | null => {
    const entry = history.undo.at(-1);
    if (!entry || !sameDocument(entry.after.document, current)) return null;
    return {
        history: { undo: history.undo.slice(0, -1), redo: [...history.redo, entry] },
        snapshot: createComposerReferenceHistorySnapshot(entry.before.document, entry.before.mentions, entry.before.selection),
    };
};

export const redoComposerReferenceHistory = (
    history: ComposerReferenceHistoryState,
    current: ComposerDocument,
): { history: ComposerReferenceHistoryState; snapshot: ComposerReferenceHistorySnapshot } | null => {
    const entry = history.redo.at(-1);
    if (!entry || !sameDocument(entry.before.document, current)) return null;
    return {
        history: { undo: [...history.undo, entry], redo: history.redo.slice(0, -1) },
        snapshot: createComposerReferenceHistorySnapshot(entry.after.document, entry.after.mentions, entry.after.selection),
    };
};
