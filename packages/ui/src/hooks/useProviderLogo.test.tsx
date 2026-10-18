import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useProviderLogo } from './useProviderLogo';

function Logo({ id }: { id: string }) {
    const { src } = useProviderLogo(id);
    return src ? <img src={src} /> : <span>fallback</span>;
}

describe('provider brand logos', () => {
    it.each([
        ['cursor', 'cursor'], ['grok', 'xai'], ['codex', 'openai'],
        ['zcode', 'zai-coding-plan'], ['workbuddy', 'workbuddy'], ['opencode-go', 'opencode'],
        ['Grok (SuperGrok)', 'xai'], ['custom-cursor', 'cursor'],
    ])('resolves Magpie %s to the %s brand asset', (provider, asset) => {
        const html = renderToStaticMarkup(<Logo id={`magpie:gateway:${encodeURIComponent(provider)}`} />);
        expect(html).toBe(renderToStaticMarkup(<Logo id={asset} />));
        expect(html).not.toContain('fallback');
    });

    it('does not infer a brand from the gateway identity', () => {
        expect(renderToStaticMarkup(<Logo id="magpie:cursor:unknown" />)).toContain('fallback');
        expect(renderToStaticMarkup(<Logo id="magpie:gateway:%invalid" />)).toContain('fallback');
    });

    it('keeps existing provider aliases', () => {
        expect(renderToStaticMarkup(<Logo id="codex" />)).toBe(renderToStaticMarkup(<Logo id="openai" />));
        expect(renderToStaticMarkup(<Logo id="github-copilot" />)).not.toContain('fallback');
    });
});
