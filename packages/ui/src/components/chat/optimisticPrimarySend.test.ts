import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeComposerDocument } from '@/composer/document';
import { messageWithComposerQuotes } from '@/stores/composerQuotes';
import { shouldOptimisticPrimarySend } from './optimisticPrimarySend';

const eligible = {
    surfaceKind: 'primary' as const,
    currentSessionId: 'ses_1',
    queuedOnly: false,
    resourcePolicy: false,
    inputMode: 'normal' as const,
    localCommand: null,
};

describe('shouldOptimisticPrimarySend', () => {
    test('the pre-await paint uses expanded paste content at the Composer call site', () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
        const content = source.match(/optimisticTicket = sessionActions\.beginOptimisticSend\(\{[\s\S]*?content: ([\s\S]*?),\s*providerID:/)?.[1];
        expect(content).toBeDefined();
        const text = 'Pasted original text\nSecond line';
        const document = {
            text: '[Paste 1]',
            references: [{ id: 'paste', kind: 'paste' as const, text, characterCount: text.length, index: 1, display: '[Paste 1]', start: 0, end: 9 }],
        };
        const serialized = serializeComposerDocument(document, 'direct-send-display');
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) return;
        const firstPaint = new Function(
            'quotesRideAlong', 'messageWithComposerQuotes', 'quotesAtSubmit', 'logicalInputMessage', 'inputSnapshot',
            `return (${content});`,
        )(false, messageWithComposerQuotes, [], serialized.text, { message: document.text });
        expect(firstPaint).toBe(text);
    });

    test('keeps a ticket for ordinary primary send and remote slash prompts', () => {
        expect(shouldOptimisticPrimarySend(eligible)).toBe(true);
        // Remote slash prompts are not local commands; they stay on the ticket path.
        expect(shouldOptimisticPrimarySend({ ...eligible, localCommand: null })).toBe(true);
    });

    test('skips tickets for local magic commands', () => {
        for (const localCommand of ['fork', 'undo', 'redo', 'compact', 'timeline', 'summary']) {
            expect(shouldOptimisticPrimarySend({ ...eligible, localCommand })).toBe(false);
        }
    });

    test('native queue admission stays off the transcript while direct steer still paints', () => {
        expect(shouldOptimisticPrimarySend({ ...eligible, delivery: 'queue' })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, delivery: 'steer' })).toBe(true);
    });

    test('skips secondary, queue-only, resource-preserving, shell, and missing session', () => {
        expect(shouldOptimisticPrimarySend({ ...eligible, surfaceKind: 'secondary' })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, queuedOnly: true })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, resourcePolicy: true })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, inputMode: 'shell' })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, currentSessionId: null })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, currentSessionId: '' })).toBe(false);
    });
});
