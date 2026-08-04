import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useEvent } from '@reactuses/core';

import { useRenderPhaseCallback } from '@/hooks/useRenderPhaseCallback';

// This suite lives beside the bug it protects rather than beside the hook:
// several `src/hooks` tests replace the `react` module process-wide, which
// leaves `react-dom/server` unable to load.
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const messageListSource = readFileSync(join(sourceDirectory, 'MessageList.tsx'), 'utf-8');
const turnAssistantBlockSource = readFileSync(
    join(sourceDirectory, 'components', 'TurnAssistantBlock.tsx'),
    'utf-8',
);
const turnItemSource = readFileSync(join(sourceDirectory, 'components', 'TurnItem.tsx'), 'utf-8');

type RenderProp = () => number;

const Consumer = ({ render }: { render: RenderProp }) => <span>{String(render())}</span>;

/**
 * Models the shape of the real defect: a parent whose inputs change during the
 * render pass, handing a render prop to a child that calls it while rendering.
 * Layout effects have not run at the moment the child calls back, which is
 * exactly the window `useEvent` cannot cover.
 */
const makeProbe = (useCallbackHook: (fn: RenderProp) => RenderProp) => () => {
    const [generation, setGeneration] = React.useState(0);
    if (generation < 2) {
        setGeneration(generation + 1);
    }
    const render = useCallbackHook(() => generation);
    return <Consumer render={render} />;
};

describe('render-phase callbacks', () => {
    test('a render prop sees the current render values, not the previous ones', () => {
        const Probe = makeProbe(useRenderPhaseCallback);
        expect(renderToStaticMarkup(<Probe />)).toBe('<span>2</span>');
    });

    test('useEvent is stale in the same position, which is why it cannot be used here', () => {
        const Probe = makeProbe(useEvent);
        expect(renderToStaticMarkup(<Probe />)).toBe('<span>0</span>');
    });

    test('keeps one identity across renders so memoized children still bail out', () => {
        const identities: RenderProp[] = [];
        const Probe = () => {
            const [generation, setGeneration] = React.useState(0);
            if (generation < 2) {
                setGeneration(generation + 1);
            }
            const render = useRenderPhaseCallback(() => generation);
            identities.push(render);
            return <Consumer render={render} />;
        };

        renderToStaticMarkup(<Probe />);

        expect(identities.length).toBeGreaterThan(1);
        expect(new Set(identities).size).toBe(1);
    });

    test('forwards every argument and the return value', () => {
        const Probe = () => {
            const join = useRenderPhaseCallback((a: string, b: number, c: boolean) => `${a}:${b}:${c}`);
            return <span>{join('x', 2, true)}</span>;
        };

        expect(renderToStaticMarkup(<Probe />)).toBe('<span>x:2:true</span>');
    });
});

describe('MessageList render props', () => {
    test('render props are invoked during render, so they cannot use useEvent', () => {
        // A turn that just grew resolved its new message against the previous
        // render's assistant index: the lookup missed, `turnGroupingContext`
        // came out undefined, and the message rendered as a standalone
        // assistant with its own model header and the between-turns `pb-8` gap.
        // `TurnItem` is memoized on the turn, so that render committed for good.
        expect(messageListSource).toContain('const renderMessage = useRenderPhaseCallback(');
        expect(messageListSource).toContain('const renderEntry = useRenderPhaseCallback(');
        expect(messageListSource).not.toContain('const renderMessage = useEvent(');
        expect(messageListSource).not.toContain('const renderEntry = useEvent(');
    });

    test('the assistant block still calls the render prop during its own render', () => {
        // If this ever moves into an effect or a memo the hook choice above
        // stops mattering, and the reasoning recorded here goes stale.
        expect(turnAssistantBlockSource).toContain(
            'assistantMessages.map((message) => renderMessage(message, activityExpanded))',
        );
    });

    test('turn grouping is what decides assistant spacing, so it must never be dropped', () => {
        // `assistantIndex` gates the whole grouping context; a miss silently
        // degrades the row rather than throwing.
        expect(messageListSource).toContain('const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;');
        expect(messageListSource).toContain('const isAssistantMessage = assistantIndex >= 0;');
    });

    test('passes turn activity expansion as an explicit memo presentation prop', () => {
        expect(messageListSource).toContain('activityExpanded={isGroupExpandedByDefault}');
        expect(turnItemSource).toContain('activityExpanded: boolean;');
        expect(turnItemSource).toContain('data-turn-activity-expanded={activityExpanded}');
        expect(turnItemSource).toContain('activityExpanded={activityExpanded}');
        expect(turnAssistantBlockSource).toContain('activityExpanded: boolean;');
        expect(turnAssistantBlockSource).toContain('data-turn-assistant-activity-expanded={activityExpanded}');
        expect(turnAssistantBlockSource).toContain('export default React.memo(TurnAssistantBlock)');
    });

    test('threads activityExpanded into renderMessage so React Compiler cannot cache stale isGroupExpanded', () => {
        // Root cause: toggle updated wrapper data-* attrs, but Compiler reused
        // `map(message => renderMessage(message))` because renderMessage identity
        // was stable and expansion lived only in a closure / sibling prop.
        // Explicit second arg makes expansion a map-call dependency.
        expect(turnItemSource).toContain(
            'renderMessage: (message: ChatMessageEntry, activityExpanded: boolean) => React.ReactNode',
        );
        expect(turnAssistantBlockSource).toContain(
            'renderMessage: (message: ChatMessageEntry, activityExpanded: boolean) => React.ReactNode',
        );
        expect(turnItemSource).toContain('renderMessage(turn.userMessage, activityExpanded)');
        expect(turnAssistantBlockSource).toContain(
            'assistantMessages.map((message) => renderMessage(message, activityExpanded))',
        );
        expect(messageListSource).toContain(
            'const renderMessage = useRenderPhaseCallback((message: ChatMessageEntry, activityExpanded: boolean) => {',
        );
        expect(messageListSource).toContain('isGroupExpanded: activityExpanded,');
        expect(messageListSource).not.toContain('isGroupExpanded: isGroupExpandedByDefault,');
    });
});
