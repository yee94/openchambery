import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';

import { resolveAssistantErrorPresentation, shouldSuppressAssistantError } from './assistantErrorPresentation';

const abortedText = 'Generation stopped';
const messageBodySource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'MessageBody.tsx'),
    'utf-8',
);
const chatMessageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../ChatMessage.tsx'),
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
        )).toEqual({ text: 'retrying', variant: 'info' });
        expect(resolveAssistantErrorPresentation(
            { message: 'unauthorized token refresh failed' },
            abortedText,
        )).toEqual({ text: PROVIDER_AUTH_FAILURE_MESSAGE, variant: 'error' });
        expect(resolveAssistantErrorPresentation(
            { message: 'provider 500' },
            abortedText,
        )).toEqual({ text: 'provider 500', variant: 'error' });
    });

    test('renders OpenCode structured generation errors as the raw detail', () => {
        expect(resolveAssistantErrorPresentation(
            { type: 'provider.no-route', message: 'Model unavailable: xai/grok-4.5' },
            abortedText,
        )).toEqual({ text: 'Model unavailable: xai/grok-4.5', variant: 'error' });
        expect(resolveAssistantErrorPresentation(
            { type: 'unknown', message: 'Generation credentials are unavailable' },
            abortedText,
        )).toEqual({ text: 'Generation credentials are unavailable', variant: 'error' });
    });
});

describe('shouldSuppressAssistantError', () => {
    test('hides errors on earlier assistants once a later sibling exists', () => {
        expect(shouldSuppressAssistantError(false)).toBe(true);
        expect(shouldSuppressAssistantError(true)).toBe(false);
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

    test('error and info chips are compact meta text, not a markdown callout', () => {
        const mutedStart = messageBodySource.indexOf('isMutedError ? (');
        const errorBlockEnd = messageBodySource.indexOf('</FadeInOnReveal>', mutedStart);
        const errorBlock = messageBodySource.slice(mutedStart, errorBlockEnd);
        expect(mutedStart).toBeGreaterThan(-1);
        expect(errorBlockEnd).toBeGreaterThan(mutedStart);
        expect(errorBlock).toContain('typography-meta');
        expect(errorBlock).toContain('status-error-border');
        expect(errorBlock).toContain('status-info-border');
        expect(errorBlock).not.toContain('SimpleMarkdownRenderer');
        expect(errorBlock).not.toContain('p-3');
    });

    test('ChatMessage suppresses non-terminal assistant errors and unmounts empty recovered rows', () => {
        expect(chatMessageSource).toContain('shouldSuppressAssistantError');
        expect(chatMessageSource).toContain('shouldHideEmptyAssistant');
    });
});
