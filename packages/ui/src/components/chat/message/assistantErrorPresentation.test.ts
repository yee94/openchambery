import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';

import { resolveAssistantErrorPresentation } from './assistantErrorPresentation';

const abortedText = 'Generation stopped';
const messageBodySource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'MessageBody.tsx'),
    'utf-8',
);

describe('resolveAssistantErrorPresentation', () => {
    test('returns nothing without a usable error detail', () => {
        expect(resolveAssistantErrorPresentation(undefined, abortedText)).toBeUndefined();
        expect(resolveAssistantErrorPresentation({}, abortedText)).toBeUndefined();
    });

    test('renders user abort as muted short copy', () => {
        expect(resolveAssistantErrorPresentation(
            { name: 'MessageAbortedError', data: { message: 'aborted' } },
            abortedText,
        )).toEqual({ text: abortedText, variant: 'muted' });
        expect(resolveAssistantErrorPresentation(
            { message: 'aborted' },
            abortedText,
        )).toEqual({ text: abortedText, variant: 'muted' });
    });

    test('keeps retry notices as info and failures as error', () => {
        expect(resolveAssistantErrorPresentation(
            { name: 'SessionRetry', message: 'retrying' },
            abortedText,
        )).toMatchObject({ variant: 'info' });
        expect(resolveAssistantErrorPresentation(
            { message: 'unauthorized token refresh failed' },
            abortedText,
        )).toEqual({ text: PROVIDER_AUTH_FAILURE_MESSAGE, variant: 'error' });
        expect(resolveAssistantErrorPresentation(
            { message: 'provider 500' },
            abortedText,
        )).toMatchObject({ variant: 'error' });
    });
});

describe('assistant abort presentation', () => {
    test('muted abort copy is gray text, not an info alert', () => {
        const mutedStart = messageBodySource.indexOf('isMutedError ? (');
        const mutedEnd = messageBodySource.indexOf(') : (', mutedStart);
        const mutedBranch = messageBodySource.slice(mutedStart, mutedEnd);
        expect(mutedStart).toBeGreaterThan(-1);
        expect(mutedEnd).toBeGreaterThan(mutedStart);
        expect(mutedBranch).toContain('typography-meta text-muted-foreground');
        expect(mutedBranch).toContain('name="stop-circle"');
        expect(mutedBranch).not.toContain('status-info-border');
        expect(mutedBranch).not.toContain('information');
        expect(mutedBranch).not.toContain('SimpleMarkdownRenderer');
    });
});
