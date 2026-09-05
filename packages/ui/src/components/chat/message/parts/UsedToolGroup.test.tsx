import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { UsedToolGroup } from './UsedToolGroup';

const usedActivity = (
    id: string,
    tool: string,
    status: string,
    extras?: { additions?: number; deletions?: number },
): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId: 'message-1',
    partIndex: 0,
    kind: 'tool',
    part: {
        id,
        type: 'tool',
        callID: `call-${id}`,
        tool,
        state: {
            status,
            metadata: extras
                ? { additions: extras.additions, deletions: extras.deletions }
                : undefined,
        },
    },
} as unknown as TurnActivityRecord);

describe('UsedToolGroup', () => {
    test('renders a collapsed running summary with shimmer and no children', () => {
        const activities = [
            usedActivity('edit-1', 'edit', 'running', { additions: 3, deletions: 1 }),
            usedActivity('edit-2', 'edit', 'completed', { additions: 2, deletions: 4 }),
            usedActivity('bash-1', 'bash', 'completed'),
            usedActivity('bash-2', 'bash', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <UsedToolGroup activities={activities} isMobile={false}>
                    <div>hidden child</div>
                </UsedToolGroup>
            </I18nProvider>,
        );

        expect(markup).toContain('data-component="used-tool-group"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('Running');
        expect(markup).toContain('2 edits, 2 commands');
        expect(markup).toContain('+5');
        expect(markup).toContain('-5');
        expect(markup).toContain('animate-text-shimmer');
        expect(markup).not.toContain('hidden child');
    });

    test('renders settled Used label without shimmer', () => {
        const activities = [
            usedActivity('write-1', 'write', 'completed', { additions: 8, deletions: 0 }),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <UsedToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('Used');
        expect(markup).toContain('1 edit');
        expect(markup).toContain('+8');
        expect(markup).not.toContain('animate-text-shimmer');
        expect(markup).not.toContain('Running');
    });
});
