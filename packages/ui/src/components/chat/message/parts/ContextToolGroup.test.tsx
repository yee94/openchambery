import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { useI18nStore } from '@/lib/i18n/store';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { ContextToolGroup } from './ContextToolGroup';
import { LatticeOrb } from './LatticeOrb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flipUpTextSource = readFileSync(join(__dirname, 'FlipUpText.tsx'), 'utf-8');
const indexCssSource = readFileSync(join(__dirname, '../../../../index.css'), 'utf-8');

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
    test('renders an accessible 3 by 3 lattice at desktop and mobile sizes', () => {
        const desktopMarkup = renderToStaticMarkup(<LatticeOrb label="Exploring" />);
        const mobileMarkup = renderToStaticMarkup(<LatticeOrb isMobile label="Exploring" />);

        expect(desktopMarkup).toContain('aria-label="Exploring"');
        expect(desktopMarkup).toContain('relative block flex-none overflow-clip');
        expect(desktopMarkup).toContain('width:14px;height:14px');
        expect(mobileMarkup).toContain('width:12px;height:12px');
        expect(desktopMarkup.match(/oc-lattice-orb-dot/g)).toHaveLength(9);
        expect(desktopMarkup).toContain('data-center="true"');
        expect(desktopMarkup).toContain('left:4px;top:4px;width:4px;height:4px');
        expect(desktopMarkup).toContain('left:24px;top:24px;width:4px;height:4px');
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
        expect(markup).toContain('Running');
        expect(markup).toContain('1 search, 3 reads');
        expect(markup).toContain('inline-flex flex-none items-center justify-center self-center h-6 w-3.5');
        expect(markup).toContain('width:14px;height:14px');
        expect(markup).toContain('typography-meta inline-flex min-h-0 w-0 min-w-0 max-w-full flex-1 items-center');
        expect(markup).toContain('oc-summary-flip-viewport relative block h-5 min-h-0 w-full min-w-0 max-w-full overflow-clip sm:h-6');
    });

    test('centers a 12px orb in the 16px leading slot on mobile', () => {
        const activities = [contextActivity('grep-1', 'grep', 'running')];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile />
            </I18nProvider>,
        );

        expect(markup).toContain('inline-flex flex-none items-center justify-center self-center h-5 w-4');
        expect(markup).toContain('width:12px;height:12px');
        expect(markup).toContain('min-h-0 min-w-0 items-center gap-1.5 overflow-clip');
        expect(markup).not.toContain('flex w-full min-h-0 min-w-0 items-center gap-1.5 overflow-clip');
    });

    test('clips both moving layers inside a fixed-height paint viewport', () => {
        expect(flipUpTextSource).toContain("'oc-summary-flip-viewport relative block h-5 min-h-0 w-full min-w-0 max-w-full overflow-clip sm:h-6'");
        expect(flipUpTextSource).toContain('oc-summary-flip-stage absolute inset-0 block overflow-clip');
        expect(indexCssSource).toContain('overflow: clip;');
        expect(flipUpTextSource).toContain('oc-summary-flip-out absolute inset-x-0 top-0 block h-full truncate');
        expect(flipUpTextSource).toContain('oc-summary-flip-in absolute inset-x-0 top-0 block h-full truncate');
        expect(indexCssSource).toContain('.oc-summary-flip-viewport,');
        expect(indexCssSource).toContain('.oc-summary-flip-stage {');
        expect(indexCssSource).toContain('contain: strict;');
        expect(indexCssSource).toContain('transform: translateZ(0);');
        expect(indexCssSource).toContain('-webkit-mask-image: linear-gradient(#000 0 100%);');
        expect(indexCssSource).toContain('-webkit-clip-path: inset(0);');
        expect(indexCssSource).not.toContain('.oc-summary-flip-out,\n.oc-summary-flip-in {\n  will-change: transform;');
        expect(indexCssSource).toContain('transform: translateY(-100%);');
        expect(indexCssSource).toContain('transform: translateY(100%);');
        expect(indexCssSource).toContain('animation: oc-summary-flip-out 280ms ease-out forwards;');
        expect(indexCssSource).toContain('animation: oc-summary-flip-in 280ms ease-out forwards;');
        expect(indexCssSource).toContain('.oc-summary-flip-out {\n    display: none;');
        expect(indexCssSource).toContain('.oc-summary-flip-in {\n    transform: none;\n    opacity: 1;');
    });

    test('keeps running after grouped calls settle until a later non-process part appears', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'completed'),
        ];
        const liveMarkup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} isTurnLive />
            </I18nProvider>,
        );
        const settledMarkup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup
                    activities={activities}
                    isMobile={false}
                    isTurnLive
                    hasFollowingOtherType
                />
            </I18nProvider>,
        );

        expect(liveMarkup).toContain('Running');
        expect(liveMarkup).toContain('oc-lattice-orb-dot');
        expect(settledMarkup).toContain('Used');
        expect(settledMarkup).toContain('#oc-search');
        expect(settledMarkup).toContain('inline-flex flex-none items-center justify-center self-center h-6 w-3.5');
        expect(settledMarkup).not.toContain('oc-lattice-orb-dot');
    });

    test('defaults to settled when every grouped call settles and exploring is omitted', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('Used');
        expect(markup).toContain('#oc-search');
        expect(markup).not.toContain('oc-lattice-orb-dot');
    });

    test('keeps running when parent passes explicit exploring after tools settle', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'completed'),
        ];
        const exploringMarkup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} exploring />
            </I18nProvider>,
        );
        const exploredMarkup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} exploring={false} />
            </I18nProvider>,
        );

        expect(exploringMarkup).toContain('Running');
        expect(exploringMarkup).toContain('oc-lattice-orb-dot');
        expect(exploredMarkup).toContain('Used');
        expect(exploredMarkup).toContain('#oc-search');
        expect(exploredMarkup).not.toContain('oc-lattice-orb-dot');
    });

    test('folds explore and used tools into one Used summary with line diffs', () => {
        const activities = [
            contextActivity('grep-1', 'grep', 'completed'),
            contextActivity('read-1', 'read', 'completed'),
            {
                ...contextActivity('edit-1', 'edit', 'completed'),
                part: {
                    id: 'edit-1',
                    type: 'tool',
                    callID: 'call-edit-1',
                    tool: 'edit',
                    state: { status: 'completed', metadata: { additions: 4, deletions: 2 } },
                },
            } as unknown as TurnActivityRecord,
            contextActivity('bash-1', 'bash', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <ContextToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('data-component="context-tool-group"');
        expect(markup).toContain('Used');
        expect(markup).toContain('1 search, 1 read, 1 edit, 1 command');
        expect(markup).toContain('+4');
        expect(markup).toContain('-2');
        expect(markup).not.toContain('Explored');
        expect(markup).not.toContain('data-component="used-tool-group"');
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

        expect(markup).toContain('Running');
        expect(markup).toContain('oc-lattice-orb-dot');
    });

    test('uses used-group copy for the unified fold in zh-CN', () => {
        const previous = useI18nStore.getState();
        useI18nStore.setState({
            locale: 'zh-CN',
            dictionary: zhCN,
            loadingLocale: null,
        });
        try {
            const settled = [
                contextActivity('grep-1', 'grep', 'completed'),
                contextActivity('read-1', 'read', 'completed'),
            ];
            const settledMarkup = renderToStaticMarkup(
                <I18nProvider>
                    <ContextToolGroup activities={settled} isMobile={false} />
                </I18nProvider>,
            );
            const liveMarkup = renderToStaticMarkup(
                <I18nProvider>
                    <ContextToolGroup activities={settled} isMobile={false} isTurnLive />
                </I18nProvider>,
            );

            expect(settledMarkup).toContain('运行了');
            expect(settledMarkup).not.toContain('探索');
            expect(liveMarkup).toContain('运行中');
            expect(liveMarkup).not.toContain('探索');
        } finally {
            useI18nStore.setState({
                locale: previous.locale,
                dictionary: previous.dictionary,
                loadingLocale: previous.loadingLocale,
            });
        }
    });
});
