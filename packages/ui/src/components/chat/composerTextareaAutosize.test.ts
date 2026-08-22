import { describe, expect, test } from 'vitest';
import { MAX_VISIBLE_TEXTAREA_LINES, resolveComposerTextareaAutosize } from './composerTextareaAutosize';

describe('resolveComposerTextareaAutosize', () => {
    test('grows with short content and does not open a scrollbar', () => {
        expect(resolveComposerTextareaAutosize({
            scrollHeight: 52,
            dictationHeight: 0,
            lineHeight: 20,
            paddingTotal: 16,
        })).toEqual({
            height: 52,
            maxHeight: 20 * MAX_VISIBLE_TEXTAREA_LINES + 16,
            overflowY: 'hidden',
        });
    });

    test('a single mention line stays non-scrollable even when dictation is taller', () => {
        expect(resolveComposerTextareaAutosize({
            scrollHeight: 24,
            dictationHeight: 40,
            lineHeight: 20,
            paddingTotal: 16,
        }).overflowY).toBe('hidden');
    });

    test('only scrolls after the visible line cap', () => {
        const sized = resolveComposerTextareaAutosize({
            scrollHeight: 400,
            dictationHeight: 0,
            lineHeight: 20,
            paddingTotal: 16,
        });
        expect(sized.height).toBe(20 * MAX_VISIBLE_TEXTAREA_LINES + 16);
        expect(sized.overflowY).toBe('auto');
    });
});
