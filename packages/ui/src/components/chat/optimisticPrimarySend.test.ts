import { describe, expect, test } from 'bun:test';
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

    test('skips secondary, queue-only, resource-preserving, shell, and missing session', () => {
        expect(shouldOptimisticPrimarySend({ ...eligible, surfaceKind: 'secondary' })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, queuedOnly: true })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, resourcePolicy: true })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, inputMode: 'shell' })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, currentSessionId: null })).toBe(false);
        expect(shouldOptimisticPrimarySend({ ...eligible, currentSessionId: '' })).toBe(false);
    });
});
