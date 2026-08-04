import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Part } from '@opencode-ai/sdk/v2';

import { MarkdownHydrationProvider } from '../../markdown/MarkdownHydrationProvider';
import JustificationBlock from './JustificationBlock';

const part = {
    id: 'activity-text-1',
    type: 'text',
    text: '> Keep this blockquote\n\nOpen `src/example.ts`.',
    sessionID: 'session-1',
    time: { start: 1, end: 2 },
} as unknown as Part;

describe('JustificationBlock', () => {
    test('renders projected activity text as ordinary assistant content with message actions', () => {
        const markup = renderToStaticMarkup(
            <MarkdownHydrationProvider enabled={false}>
                <JustificationBlock
                    part={part}
                    messageId="message-1"
                    streamPhase="completed"
                    actions={<button type="button">Copy action</button>}
                />
            </MarkdownHydrationProvider>,
        );

        expect(markup).toContain('&gt; Keep this blockquote');
        expect(markup).toContain('Open `src/example.ts`.');
        expect(markup).toContain('markdown-content leading-relaxed');
        expect(markup).toContain('data-message-text-export-root="true"');
        expect(markup).toContain('data-message-text-export-source="true"');
        expect(markup).toContain('data-message-actions="true"');
        expect(markup).toContain('data-message-action-group="true"');
        expect(markup).toContain('Copy action');
        expect(markup).not.toContain('Justification');
        expect(markup).not.toContain('理由');
        expect(markup).not.toContain('aria-expanded');
        expect(markup).not.toContain('aria-controls');
        expect(markup).not.toContain('brain-ai-3');
        expect(markup).not.toContain('markdown-reasoning');
    });
});
