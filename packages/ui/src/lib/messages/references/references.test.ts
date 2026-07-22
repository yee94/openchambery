import { describe, expect, test } from 'bun:test';
import {
    buildMessageReferenceParts,
    detectMessageReferences,
    hasMessageReferenceHint,
    toComposerHighlightRanges,
    tokenizeMessageReferences,
} from './index';

describe('hasMessageReferenceHint', () => {
    test('rejects plain prose without reference markers', () => {
        expect(hasMessageReferenceHint('hello world')).toBe(false);
    });

    test('accepts slash, bracket, and mention markers', () => {
        expect(hasMessageReferenceHint('use /review')).toBe(true);
        expect(hasMessageReferenceHint('[skill:review]')).toBe(true);
        expect(hasMessageReferenceHint('see @agent')).toBe(true);
    });
});

describe('detectMessageReferences', () => {
    test('materializes canonical skill and command tags into display labels', () => {
        const spans = detectMessageReferences('[skill:review] then [command:/abs/run.md]');
        expect(spans.map((span) => [span.kind, span.label, span.raw])).toEqual([
            ['skill', '/review', '[skill:review]'],
            ['command', '/run', '[command:/abs/run.md]'],
        ]);
    });

    test('highlights installed slash skills without treating unknown tokens as skills', () => {
        const spans = detectMessageReferences('run /review and /not-a-skill', {
            skillNames: new Set(['review']),
        });
        expect(spans).toEqual([
            {
                start: 4,
                end: 11,
                kind: 'skill',
                raw: '/review',
                label: '/review',
                payload: { kind: 'skill', skillName: 'review' },
            },
        ]);
    });

    test('decorates image citations and skips markdown links', () => {
        const spans = detectMessageReferences('see [shot.png] and [docs](https://example.com)', {
            citationIcons: new Map([['shot.png', 'image']]),
        });
        expect(spans.map((span) => [span.kind, span.label])).toEqual([
            ['image', 'shot.png'],
        ]);
    });

    test('infers image citations from common extensions without explicit context', () => {
        const spans = detectMessageReferences('paste [desktop.webp]');
        expect(spans.map((span) => [span.kind, span.label])).toEqual([
            ['image', 'desktop.webp'],
        ]);
    });

    test('detects session tokens and path/agent mentions', () => {
        const spans = detectMessageReferences('ask @build about @src/a.ts and @session:ses_1', {
            agentNames: new Set(['build']),
            allowPathHeuristics: true,
            sessionTitles: new Map([['ses_1', 'Prior chat']]),
        });
        expect(spans.map((span) => [span.kind, span.label])).toEqual([
            ['agent', '@build'],
            ['file', '@src/a.ts'],
            ['session', 'Prior chat'],
        ]);
    });

    test('prefers skill over command when a slash name exists in both sets', () => {
        const spans = detectMessageReferences('/review', {
            skillNames: new Set(['review']),
            commandNames: new Set(['review']),
        });
        expect(spans.map((span) => span.kind)).toEqual(['skill']);
    });
});

describe('tokenizeMessageReferences', () => {
    test('splits plain text around decorated spans', () => {
        const spans = detectMessageReferences('Start /review now', {
            skillNames: new Set(['review']),
        });
        const parts = tokenizeMessageReferences('Start /review now', spans);
        expect(parts.map((part) => part.type === 'text' ? part.text : [part.decoration.kind, part.decoration.label, part.decoration.icon])).toEqual([
            'Start ',
            ['skill', '/review', 'book-open'],
            ' now',
        ]);
    });

    test('buildMessageReferenceParts returns null for undecorated text', () => {
        expect(buildMessageReferenceParts('plain text only')).toBeNull();
    });

    test('buildMessageReferenceParts hides citation wrappers in decoration labels', () => {
        const parts = buildMessageReferenceParts('[image-1.png] please review', {
            citationIcons: new Map([['image-1.png', 'image']]),
        });
        expect(parts?.[0]?.type).toBe('reference');
        if (parts?.[0]?.type !== 'reference') throw new Error('expected reference part');
        expect([parts[0].decoration.kind, parts[0].decoration.label, parts[0].decoration.icon]).toEqual([
            'image',
            'image-1.png',
            'file-image',
        ]);
    });
});

describe('toComposerHighlightRanges', () => {
    test('projects skill and image spans into overlay-compatible ranges', () => {
        const spans = detectMessageReferences('/review [shot.png]', {
            skillNames: new Set(['review']),
            citationIcons: new Map([['shot.png', 'image']]),
        });
        expect(toComposerHighlightRanges(spans).map((range) => [
            range.style,
            range.skillName ?? range.visual?.label,
            range.visual?.icon,
        ])).toEqual([
            ['mentionCommand', 'review', 'book-open'],
            ['mentionFile', 'shot.png', 'file-image'],
        ]);
    });
});
