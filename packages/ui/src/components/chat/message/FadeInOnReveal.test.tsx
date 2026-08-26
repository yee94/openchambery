import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FadeInDisabledProvider, FadeInOnReveal } from './FadeInOnReveal';

const originalMatchMedia = window.matchMedia;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const chatMessageSource = readFileSync(join(sourceDirectory, '..', 'ChatMessage.tsx'), 'utf-8');
const messageListSource = readFileSync(join(sourceDirectory, '..', 'MessageList.tsx'), 'utf-8');
const fadeSource = readFileSync(join(sourceDirectory, 'FadeInOnReveal.tsx'), 'utf-8');

afterEach(() => {
    window.matchMedia = originalMatchMedia;
});

describe('message appearance fade', () => {
    test('keeps the global fade opt-in and wires both new-message paths through the provider', () => {
        expect(fadeSource).toContain('const FADE_ANIMATION_ENABLED = false;');
        expect(chatMessageSource).toContain('skipAnimation={!animateUserOnMount}');
        expect(chatMessageSource).toContain('skipAnimation={!animateAssistantOnMount}');
        expect(chatMessageSource).not.toContain('ignoreContextDisabled');
        expect(messageListSource).toContain('<FadeInDisabledProvider disabled={shouldVirtualizeHistory}>');
    });

    test('animates an explicitly new message', () => {
        const markup = renderToStaticMarkup(
            <FadeInDisabledProvider disabled={false}>
                <FadeInOnReveal forceAnimation respectReducedMotion>
                    <div data-message-probe="true" />
                </FadeInOnReveal>
            </FadeInDisabledProvider>,
        );

        expect(markup).toContain('opacity-0 translate-y-2');
    });

    test('keeps virtualized history remounts static', () => {
        const markup = renderToStaticMarkup(
            <FadeInDisabledProvider disabled>
                <FadeInOnReveal forceAnimation respectReducedMotion>
                    <div data-message-probe="true" />
                </FadeInOnReveal>
            </FadeInDisabledProvider>,
        );

        expect(markup).not.toContain('opacity-0 translate-y-2');
        expect(markup).toContain('data-message-probe="true"');
    });

    test('keeps an outer animation gate active through nested providers', () => {
        const markup = renderToStaticMarkup(
            <FadeInDisabledProvider disabled>
                <FadeInDisabledProvider disabled={false}>
                    <FadeInOnReveal forceAnimation respectReducedMotion>
                        <div data-message-probe="true" />
                    </FadeInOnReveal>
                </FadeInDisabledProvider>
            </FadeInDisabledProvider>,
        );

        expect(markup).not.toContain('opacity-0 translate-y-2');
        expect(markup).toContain('data-message-probe="true"');
    });

    test('keeps reduced-motion messages static', () => {
        window.matchMedia = ((query: string) => ({
            matches: query === '(prefers-reduced-motion: reduce)',
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
        })) as typeof window.matchMedia;

        const markup = renderToStaticMarkup(
            <FadeInOnReveal forceAnimation respectReducedMotion>
                <div data-message-probe="true" />
            </FadeInOnReveal>,
        );

        expect(markup).not.toContain('opacity-0 translate-y-2');
    });
});
