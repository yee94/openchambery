import { describe, expect, test } from 'bun:test';
import {
    buildHighlightParts,
    resolveAtomicReferenceSelection,
    resolveSkillMentionDeletion,
    type HighlightRange,
} from './composerHighlight';
import {
    composerTriggerIconDisplay,
    composerTriggerIconText,
    composerTriggerIconVisual,
} from '@/composer/inline-visual';

describe('buildHighlightParts', () => {
    test('preserves skill names on skill tag parts', () => {
        const spec = { trigger: '/', icon: 'book-open', label: 'review-pr' };
        const token = composerTriggerIconDisplay(spec);
        const ranges: HighlightRange[] = [{
            start: 6,
            end: 6 + token.length,
            style: 'mentionCommand',
            skillName: 'review-pr',
            visual: composerTriggerIconVisual(spec, token),
        }];

        expect(buildHighlightParts(`Start ${token} now`, ranges)).toEqual([
            { text: 'Start ', className: 'text-foreground', skillName: undefined, visual: undefined },
            {
                text: token,
                className: 'text-[var(--primary)]',
                skillName: 'review-pr',
                visual: composerTriggerIconVisual(spec, token),
            },
            { text: ' now', className: 'text-foreground', skillName: undefined, visual: undefined },
        ]);
    });

    test('keeps ordinary text in separate plain-text segments around highlights', () => {
        const ranges: HighlightRange[] = [{ start: 6, end: 10, style: 'mentionCommand' }];

        expect(buildHighlightParts('hello /run world', ranges)).toEqual([
            { text: 'hello ', className: 'text-foreground', skillName: undefined, visual: undefined },
            { text: '/run', className: 'text-[var(--primary)]', skillName: undefined, visual: undefined },
            { text: ' world', className: 'text-foreground', skillName: undefined, visual: undefined },
        ]);
    });

    test('keeps adjacent skill tokens with different names separate', () => {
        const ranges: HighlightRange[] = [
            { start: 0, end: 6, style: 'mentionCommand', skillName: 'alpha' },
            { start: 6, end: 11, style: 'mentionCommand', skillName: 'beta' },
        ];

        expect(buildHighlightParts('/alpha/beta', ranges)).toEqual([
            { text: '/alpha', className: 'text-[var(--primary)]', skillName: 'alpha', visual: undefined },
            { text: '/beta', className: 'text-[var(--primary)]', skillName: 'beta', visual: undefined },
        ]);
    });

    test('keeps durable command and skill icon decorations separate', () => {
        const alphaSpec = { trigger: '/', icon: 'book-open', label: 'alpha' };
        const betaSpec = { trigger: '/', icon: 'command', label: 'beta' };
        const alpha = composerTriggerIconDisplay(alphaSpec);
        const beta = composerTriggerIconDisplay(betaSpec);
        const ranges: HighlightRange[] = [
            { start: 0, end: alpha.length, style: 'mentionCommand', visual: composerTriggerIconVisual(alphaSpec, alpha) },
            { start: alpha.length, end: alpha.length + beta.length, style: 'mentionCommand', visual: composerTriggerIconVisual(betaSpec, beta) },
        ];

        expect(buildHighlightParts(`${alpha}${beta}`, ranges)?.map((part) => [part.text, part.visual?.icon])).toEqual([
            [alpha, 'book-open'],
            [beta, 'command'],
        ]);
    });

    test('renders pasted text references with the shared primary color', () => {
        const ranges: HighlightRange[] = [{ start: 6, end: 15, style: 'mentionPaste' }];

        expect(buildHighlightParts('hello [Paste 5] world', ranges)).toEqual([
            { text: 'hello ', className: 'text-foreground', skillName: undefined, visual: undefined },
            { text: '[Paste 5]', className: 'text-[var(--primary)]', skillName: undefined, visual: undefined },
            { text: ' world', className: 'text-foreground', skillName: undefined, visual: undefined },
        ]);
    });

    test('preserves image citation icon semantics through highlight segmentation', () => {
        const parts = buildHighlightParts('[image-1.png] [selection.ts:1-2]', [
            {
                start: 0,
                end: 13,
                style: 'mentionFile',
                visual: composerTriggerIconVisual(
                    { trigger: '[', icon: 'file-image', label: 'image-1.png', suffix: ']' },
                    '[image-1.png]',
                ),
            },
            {
                start: 14,
                end: 32,
                style: 'mentionFile',
                visual: composerTriggerIconVisual(
                    { trigger: '[', icon: 'attachment-2', label: 'selection.ts:1-2', suffix: ']' },
                    '[selection.ts:1-2]',
                ),
            },
        ]);

        expect([parts?.[0]?.visual?.label, parts?.[0]?.visual?.icon]).toEqual(['image-1.png', 'file-image']);
        expect([parts?.[2]?.visual?.label, parts?.[2]?.visual?.icon]).toEqual(['selection.ts:1-2', 'attachment-2']);
    });

    test('uses one primary color for every composer reference kind', () => {
        const styles: HighlightRange['style'][] = [
            'mentionFile',
            'mentionAgent',
            'mentionSession',
            'mentionCommand',
            'mentionSnippet',
            'mentionPaste',
        ];

        for (const style of styles) {
            expect(buildHighlightParts('reference', [{ start: 0, end: 9, style }])?.[0]?.className)
                .toBe('text-[var(--primary)]');
        }
    });

    test('carries session trigger visuals through highlight segmentation', () => {
        const spec = { trigger: '@', icon: 'chat-thread', label: 'Current' };
        const display = composerTriggerIconDisplay(spec);
        const parts = buildHighlightParts(`${display} session`, [{
            start: 0,
            end: display.length,
            style: 'mentionSession',
            visual: composerTriggerIconVisual(spec, display),
        }]);

        expect(parts?.[0]?.visual).toEqual(composerTriggerIconVisual(spec, display));
        expect(composerTriggerIconText(spec)).toBe('@Current');
    });
});

describe('resolveSkillMentionDeletion', () => {
    test('deletes a complete skill mention from inside the token', () => {
        expect(resolveSkillMentionDeletion(
            'before /auto-research after',
            ['auto-research'],
            { key: 'Backspace', selectionStart: 15, selectionEnd: 15 },
        )).toEqual({
            text: 'before after',
            caret: 7,
            removedSkillNames: ['auto-research'],
        });
    });

    test('expands a partial selection to the complete skill mention', () => {
        const text = 'before /auto-research after';
        expect(resolveSkillMentionDeletion(
            text,
            ['auto-research'],
            {
                key: 'Delete',
                selectionStart: text.indexOf('auto') + 1,
                selectionEnd: text.indexOf('research') + 3,
            },
        )).toEqual({
            text: 'before after',
            caret: 7,
            removedSkillNames: ['auto-research'],
        });
    });

    test('leaves ordinary text deletion to the textarea', () => {
        expect(resolveSkillMentionDeletion(
            'before /auto-research after',
            ['auto-research'],
            { key: 'Backspace', selectionStart: 3, selectionEnd: 3 },
        )).toBeNull();
    });
});

describe('resolveAtomicReferenceSelection', () => {
    const ranges = [
        { start: 7, end: 21 },
        { start: 23, end: 36 },
    ];

    test('selects the complete reference when the caret enters it', () => {
        expect(resolveAtomicReferenceSelection(12, 12, ranges)).toEqual({ start: 7, end: 21 });
    });

    test('expands a partial selection across every touched reference', () => {
        expect(resolveAtomicReferenceSelection(10, 27, ranges)).toEqual({ start: 7, end: 36 });
    });

    test('keeps ordinary text selection unchanged', () => {
        expect(resolveAtomicReferenceSelection(1, 4, ranges)).toBeNull();
    });
});
