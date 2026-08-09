import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

mock.module('@/components/ui/ModelLogo', () => ({ ModelLogo: () => null }));
mock.module('@/stores/useUIStore', () => ({
    useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: true }),
}));

const { ReadOnlyPromptBanner } = await import('./ReadOnlyPromptBanner');

describe('ReadOnlyPromptBanner', () => {
    test('capitalizes the first letter of the displayed agent name', () => {
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ReadOnlyPromptBanner agentName="fixer" />
            </I18nProvider>,
        );

        expect(markup).toContain('Agent: Fixer');
        expect(markup).toContain('>Fixer</span>');
        expect(markup).toContain('oc-mobile-readonly-prompt-foot');
        expect(markup).toContain('oc-mobile-readonly-prompt-surface');
    });

    test('keeps agent and model metadata in a two-column row', () => {
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ReadOnlyPromptBanner
                    agentName="oracle"
                    providerId="openai"
                    modelId="gpt-5.6"
                    modelName="GPT-5.6 Sol Fast"
                />
            </I18nProvider>,
        );

        expect(markup).toContain('data-testid="read-only-prompt-banner-meta"');
        expect(markup).toContain('justify-between');
        expect(markup).toContain('text-[13px]');
        expect(markup).toContain('>Oracle</span>');
        expect(markup).toContain('>GPT-5.6 Sol Fast</span>');
        expect(markup).toContain('text-right');
        expect(markup).toContain('oc-mobile-readonly-prompt-foot');
    });
});
