export const MAX_VISIBLE_TEXTAREA_LINES = 8;

export function resolveComposerTextareaAutosize(input: {
    scrollHeight: number;
    dictationHeight: number;
    lineHeight: number;
    paddingTotal: number;
    maxLines?: number;
}): { height: number; maxHeight: number; overflowY: 'auto' | 'hidden' } {
    const maxLines = input.maxLines ?? MAX_VISIBLE_TEXTAREA_LINES;
    const maxHeight = input.lineHeight * maxLines + input.paddingTotal;
    const contentHeight = Math.max(input.scrollHeight, input.dictationHeight);
    return {
        height: Math.min(contentHeight, maxHeight),
        maxHeight,
        overflowY: contentHeight > maxHeight ? 'auto' : 'hidden',
    };
}
