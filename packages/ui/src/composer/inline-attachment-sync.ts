/**
 * Inline attachment citations stay in lockstep with draft attachment metadata.
 * Store remove paths call stripInlineAttachmentCitationsFromDraft so ChatInput
 * does not hand-sync textarea text after removeAttachment.
 */
import { stripComposerTriggerIconSlot } from '@/composer/inline-visual';
import type { DraftComposerReference, DraftMention } from '@/sync/input-draft-types';

export interface CitationRange {
    start: number;
    end: number;
}

export interface InlineAttachmentCitationCandidate {
    source: 'local' | 'server' | 'vscode';
    vscodeSource?: 'file' | 'selection';
    mimeType?: string;
}

export interface InlineAttachmentCitationStripResult {
    text: string;
    mentions: DraftMention[];
    composerReferences: DraftComposerReference[] | undefined;
    changed: boolean;
}

const normalizeFilenameKey = (filename: string): string => filename.trim().toLowerCase();

/** Images and VS Code code selections render as inline bracket citations. */
export const isInlineAttachmentCitation = (attachment: InlineAttachmentCitationCandidate): boolean => (
    (attachment.source === 'vscode' && attachment.vscodeSource === 'selection')
    || attachment.mimeType?.startsWith('image/') === true
);

export const findAttachmentCitationRanges = (text: string, filenames: string[]): CitationRange[] => {
    if (!text || !text.includes('[') || filenames.length === 0) {
        return [];
    }

    const known = new Set(filenames.map(normalizeFilenameKey));
    const ranges: CitationRange[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('[', cursor);
        if (start === -1) {
            break;
        }

        const end = text.indexOf(']', start + 1);
        if (end === -1) {
            break;
        }

        // Markdown links keep their normal link highlighting; attachment citations
        // are plain bracket references like [desktop.png] or reserved [␠desktop.png].
        if (text[end + 1] !== '(') {
            const name = stripComposerTriggerIconSlot(text.slice(start + 1, end)).trim();
            if (known.has(normalizeFilenameKey(name))) {
                ranges.push({ start, end: end + 1 });
            }
        }

        cursor = end + 1;
    }

    return ranges;
};

/** Expand a citation range to absorb one adjacent whitespace separator. */
const expandCitationRemovalRange = (text: string, range: CitationRange): CitationRange => {
    let start = range.start;
    let end = range.end;

    if (end < text.length && /\s/.test(text[end])) {
        end += 1;
    } else if (start > 0 && /\s/.test(text[start - 1])) {
        start -= 1;
    }

    return { start, end };
};

export const removeAttachmentCitations = (text: string, filenames: string[]): string => {
    const ranges = findAttachmentCitationRanges(text, filenames);
    let nextText = text;

    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const { start, end } = expandCitationRemovalRange(nextText, ranges[index]);
        nextText = `${nextText.slice(0, start)}${nextText.slice(end)}`;
    }

    return nextText;
};

/**
 * Removes every inline citation for the given filenames and rebases mentions /
 * composer references so one DraftRecord revision stays valid.
 */
export const stripInlineAttachmentCitationsFromDraft = (
    text: string,
    filenames: string[],
    mentions: readonly DraftMention[],
    composerReferences: readonly DraftComposerReference[] | undefined,
): InlineAttachmentCitationStripResult => {
    const ranges = findAttachmentCitationRanges(text, filenames);
    if (ranges.length === 0) {
        return {
            text,
            mentions: [...mentions],
            composerReferences: composerReferences === undefined ? undefined : [...composerReferences],
            changed: false,
        };
    }

    let nextText = text;
    let nextMentions = [...mentions];
    let nextReferences = composerReferences === undefined ? [] : [...composerReferences];

    // Walk backward so earlier offsets stay stable across multi-citation deletes.
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const { start, end } = expandCitationRemovalRange(nextText, ranges[index]);
        const delta = end - start;
        nextText = `${nextText.slice(0, start)}${nextText.slice(end)}`;

        nextMentions = nextMentions.flatMap((mention) => {
            if (mention.range.end <= start) return [mention];
            if (mention.range.start >= end) {
                return [{
                    ...mention,
                    range: {
                        start: mention.range.start - delta,
                        end: mention.range.end - delta,
                    },
                }];
            }
            return [];
        });

        nextReferences = nextReferences.flatMap((reference) => {
            if (reference.end <= start) return [reference];
            if (reference.start >= end) {
                return [{
                    ...reference,
                    start: reference.start - delta,
                    end: reference.end - delta,
                }];
            }
            return [];
        });
    }

    return {
        text: nextText,
        mentions: nextMentions,
        composerReferences: composerReferences === undefined ? undefined : nextReferences,
        changed: true,
    };
};
