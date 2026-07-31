import { describe, expect, test } from 'bun:test';
import {
    advancePastTrailingBoundarySpace,
    insertTokenWithReferenceBoundaries,
    withInlineInsertionBoundaries,
    withReferenceInsertionBoundaries,
} from './insertionBoundaries';

describe('insertionBoundaries', () => {
    test('withInlineInsertionBoundaries pads mid-line neighbors', () => {
        expect(withInlineInsertionBoundaries('@agent', 'hello', 'world')).toBe(' @agent ');
        expect(withInlineInsertionBoundaries('@agent', 'hello ', ' world')).toBe('@agent');
        expect(withInlineInsertionBoundaries('@agent', '(', ')')).toBe('@agent');
    });

    test('withReferenceInsertionBoundaries pads empty document edges like image paste', () => {
        expect(withReferenceInsertionBoundaries('[image.png]', '', '')).toBe(' [image.png] ');
        expect(withReferenceInsertionBoundaries('/skill', '', '')).toBe(' /skill ');
        expect(withReferenceInsertionBoundaries('@绘画', '请帮我', '')).toBe(' @绘画 ');
        expect(withReferenceInsertionBoundaries('@绘画', '请帮我 ', '')).toBe('@绘画 ');
    });

    test('insertTokenWithReferenceBoundaries replaces the trigger range and parks caret after trailing space', () => {
        expect(insertTokenWithReferenceBoundaries('请帮我@绘', 3, 5, '@绘画')).toEqual({
            text: '请帮我 @绘画 ',
            caret: 8,
        });
        expect(insertTokenWithReferenceBoundaries('/sk', 0, 3, '/skill')).toEqual({
            text: ' /skill ',
            caret: 8,
        });
    });

    test('advancePastTrailingBoundarySpace skips one ordinary space', () => {
        expect(advancePastTrailingBoundarySpace('/skill ', 6)).toBe(7);
        expect(advancePastTrailingBoundarySpace('/skill', 6)).toBe(6);
    });
});
