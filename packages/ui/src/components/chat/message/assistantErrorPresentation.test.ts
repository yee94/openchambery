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

    test('renders the OpenCode 2 step interrupt as muted short copy, not an error chip', () => {
        expect(resolveAssistantErrorPresentation(
            { type: 'aborted', message: 'Step interrupted' },
            abortedText,
        )).toEqual({ text: abortedText, variant: 'muted' });
        expect(resolveAssistantErrorPresentation(
            { type: 'aborted', message: 'Tool execution interrupted' },
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
        )).toEqual({ text: 'Model unavailable: xai/grok-4.5', variant: 'error', detail: 'provider.no-route' });
        expect(resolveAssistantErrorPresentation(
            { type: 'unknown', message: 'Generation credentials are unavailable' },
            abortedText,
        )).toEqual({ text: 'Generation credentials are unavailable', variant: 'error' });
    });

    test('keeps the structured error code and HTTP status as a dimmed detail', () => {
        expect(resolveAssistantErrorPresentation(
            { type: 'provider.rate-limit', message: 'Too many requests', status: 429 },
            abortedText,
        )).toEqual({ text: 'Too many requests', variant: 'error', detail: 'provider.rate-limit · 429' });
        expect(resolveAssistantErrorPresentation(
            { type: 'provider.auth', message: 'Missing bearer or basic authentication in header', status: 401 },
            abortedText,
        )).toMatchObject({ variant: 'error', detail: 'provider.auth · 401' });
        expect(resolveAssistantErrorPresentation(
            { type: 'error', message: 'upstream closed', status: 502 },
            abortedText,
        )).toEqual({ text: 'upstream closed', variant: 'error', detail: '502' });
    });
});

describe('shouldSuppressAssistantError', () => {
    test('hides errors on earlier assistants once a later sibling exists', () => {
        expect(shouldSuppressAssistantError(false)).toBe(true);
        expect(shouldSuppressAssistantError(true)).toBe(false);
    });
});

describe('assistant error presentation', () => {
    const errorStart = messageBodySource.indexOf('<FadeInOnReveal key="assistant-error">');
    const errorEnd = messageBodySource.indexOf('</FadeInOnReveal>', errorStart);
    const errorBlock = messageBodySource.slice(errorStart, errorEnd);

    test('every variant is one quiet full-width meta row without a chip box', () => {
        expect(errorStart).toBeGreaterThan(-1);
        expect(errorEnd).toBeGreaterThan(errorStart);
        expect(errorBlock).toContain('flex w-full min-w-0');
        expect(errorBlock).toContain('typography-meta leading-5 text-muted-foreground');
        expect(errorBlock).not.toMatch(/\bborder\b/);
        expect(errorBlock).not.toContain('status-error-background');
        expect(errorBlock).not.toContain('status-info-background');
        expect(errorBlock).not.toContain('SimpleMarkdownRenderer');
    });

    test('status color stays on the icon; muted abort keeps the stop icon', () => {
        expect(errorBlock).toContain("errorVariant === 'error' && 'text-[var(--status-error)]/85'");
        expect(messageBodySource).toContain("? 'stop-circle'");
        expect(errorBlock).toContain('{errorDetail ? (');
    });

    test('ChatMessage suppresses non-terminal assistant errors and unmounts empty recovered rows', () => {
        expect(chatMessageSource).toContain('shouldSuppressAssistantError');
        expect(chatMessageSource).toContain('shouldHideEmptyAssistant');
    });
});
