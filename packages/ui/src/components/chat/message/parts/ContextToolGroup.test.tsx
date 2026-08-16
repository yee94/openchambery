import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { ContextToolGroup } from './ContextToolGroup';
import { LatticeOrb } from './LatticeOrb';

const contextActivity = (
    id: string,
    tool: string,
    status: string,
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
        state: { status },
    },
} as unknown as TurnActivityRecord);

describe('LatticeOrb', () => {
    test('renders an accessible 3 by 3 lattice', () => {
        const markup = renderToStaticMarkup(<LatticeOrb size={14} label="Exploring" />);

        expect(markup).toContain('aria-label="Exploring"');
        expect(markup.match(/oc-lattice-orb-dot/g)).toHaveLength(9);
        expect(markup).toContain('data-center="true"');
    });
});

describe('ContextToolGroup', () => {
    test('renders a collapsed active summary', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'running'),
            contextActivity('read-1', 'read', 'completed'),
            contextActivity('read-2', 'read', 'completed'),
            contextActivity('read-3', 'read', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('data-component="context-tool-group"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('Exploring');
        expect(markup).toContain('1 search, 3 reads');
    });

    test('settles as soon as every grouped call settles', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('Explored');
        expect(markup).toContain('#oc-search');
        expect(markup).not.toContain('oc-lattice-orb-dot');
    });

    test('keeps the group active while any member lacks settlement evidence', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'unknown'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('Exploring');
        expect(markup).toContain('oc-lattice-orb-dot');
    });
});
