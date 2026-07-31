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

/** Replace [start, end) with a display token, applying reference-style space padding. */
export const insertTokenWithReferenceBoundaries = (
    text: string,
    start: number,
    end: number,
    token: string,
): { text: string; caret: number } => {
    const before = text.slice(0, start);
    const after = text.slice(end);
    const insertion = withReferenceInsertionBoundaries(token, before, after);
    return {
        text: `${before}${insertion}${after}`,
        caret: before.length + insertion.length,
    };
};

/** Move caret past an ordinary trailing boundary space left after a chip insert. */
export const advancePastTrailingBoundarySpace = (text: string, caret: number): number => (
    caret < text.length && text[caret] === ' ' ? caret + 1 : caret
);
