/**
 * Pads ordinary spaces around an inline insertion so tokens don't glue to
 * neighboring text (attachment citations, @mentions, slash chips, etc.).
 */
export const withInlineInsertionBoundaries = (content: string, before: string, after: string): string => {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
};

/**
 * Like {@link withInlineInsertionBoundaries}, and also pads when the token sits
 * alone at a message edge — matching image/attachment citation paste behavior.
 */
export const withReferenceInsertionBoundaries = (content: string, before: string, after: string): string => {
    const insertion = withInlineInsertionBoundaries(content, before, after);
    // Only pad when the citation sits alone at a message edge — never force a
    // multi-space lead-in mid-line (that reads as a huge gap before the icon).
    const leadingSpace = before.length === 0 && !/^\s/.test(insertion) ? ' ' : '';
    const trailingSpace = after.length === 0 && !/\s$/.test(insertion) ? ' ' : '';
    return `${leadingSpace}${insertion}${trailingSpace}`;
};

export type TokenInsertWithBoundaries = {
    text: string;
    caret: number;
    /** Inclusive start of the inserted token itself (excludes automatic boundary spaces). */
    start: number;
    /** Exclusive end of the inserted token itself (excludes automatic boundary spaces). */
    end: number;
};

/** Replace [start, end) with a display token, applying reference-style space padding. */
export const insertTokenWithReferenceBoundaries = (
    text: string,
    start: number,
    end: number,
    token: string,
): TokenInsertWithBoundaries => {
    const before = text.slice(0, start);
    const after = text.slice(end);
    const insertion = withReferenceInsertionBoundaries(token, before, after);
    const tokenOffset = Math.max(0, insertion.indexOf(token));
    const tokenStart = before.length + tokenOffset;
    return {
        text: `${before}${insertion}${after}`,
        caret: before.length + insertion.length,
        start: tokenStart,
        end: tokenStart + token.length,
    };
};

/**
 * Append a durable mention when kind/value/range is not already present.
 * Matches ChatInput file/directory mention dedupe (kind:value:start:end).
 */
export const appendUniqueDraftMention = <T extends {
    kind: string;
    value: string;
    range: { start: number; end: number };
}>(mentions: readonly T[], addition: T): T[] => {
    const keyOf = (mention: T) => `${mention.kind}:${mention.value}:${mention.range.start}:${mention.range.end}`;
    const seen = new Set(mentions.map(keyOf));
    return seen.has(keyOf(addition)) ? [...mentions] : [...mentions, addition];
};

/** Move caret past an ordinary trailing boundary space left after a chip insert. */
export const advancePastTrailingBoundarySpace = (text: string, caret: number): number => (
    caret < text.length && text[caret] === ' ' ? caret + 1 : caret
);
