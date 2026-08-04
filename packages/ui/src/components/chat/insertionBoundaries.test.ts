import { describe, expect, test } from 'bun:test';
import {
    advancePastTrailingBoundarySpace,
    appendUniqueDraftMention,
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
            start: 4,
            end: 7,
        });
        expect(insertTokenWithReferenceBoundaries('/sk', 0, 3, '/skill')).toEqual({
            text: ' /skill ',
            caret: 8,
            start: 1,
            end: 7,
        });
    });

    test('insertTokenWithReferenceBoundaries token range excludes boundary spaces for agent chips', () => {
        const empty = insertTokenWithReferenceBoundaries('', 0, 0, '@build');
        expect(empty.text).toBe(' @build ');
        expect(empty.text.slice(empty.start, empty.end)).toBe('@build');
        expect(empty.start).toBe(1);
        expect(empty.end).toBe(7);

        const mid = insertTokenWithReferenceBoundaries('hello@bu', 5, 8, '@build');
        expect(mid.text).toBe('hello @build ');
        expect(mid.text.slice(mid.start, mid.end)).toBe('@build');
        expect(mid.start).toBe(6);
        expect(mid.end).toBe(12);
        expect(mid.text[mid.start - 1]).toBe(' ');
        expect(mid.text[mid.end]).toBe(' ');
    });

    test('appendUniqueDraftMention keeps existing mentions and dedupes kind/value/range', () => {
        type Mention = {
            kind: 'file' | 'agent';
            value: string;
            path: string;
            label: string;
            range: { start: number; end: number };
        };
        const existing: Mention[] = [{
            kind: 'file',
            value: 'src/a.ts',
            path: 'src/a.ts',
            label: 'src/a.ts',
            range: { start: 0, end: 9 },
        }];
        const agent: Mention = {
            kind: 'agent',
            value: 'build',
            path: 'build',
            label: 'build',
            range: { start: 10, end: 16 },
        };
        const merged = appendUniqueDraftMention(existing, agent);
        expect(merged).toEqual([...existing, agent]);
        expect(appendUniqueDraftMention(merged, agent)).toEqual(merged);
        expect(appendUniqueDraftMention(merged, { ...agent, range: { start: 20, end: 26 } })).toEqual([
            ...merged,
            { ...agent, range: { start: 20, end: 26 } },
        ]);
    });

    test('advancePastTrailingBoundarySpace skips one ordinary space', () => {
        expect(advancePastTrailingBoundarySpace('/skill ', 6)).toBe(7);
        expect(advancePastTrailingBoundarySpace('/skill', 6)).toBe(6);
    });
});
