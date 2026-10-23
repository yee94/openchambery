import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { MarkdownHydrationProvider } from './markdown/MarkdownHydrationProvider';
import { MarkdownHydrationContext } from './markdown/markdownHydrationContext';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'), 'utf8');
const ast = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let entryDeclaration = '';
let historyRenderer = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'MessageListEntry') {
        entryDeclaration = `const ${node.getText(ast)};`;
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'StaticHistoryList') {
        const findRenderer = (child: ts.Node) => {
            if (ts.isVariableDeclaration(child) && child.name.getText(ast) === 'renderEntry') {
                historyRenderer = `const ${child.getText(ast)};`;
            }
            ts.forEachChild(child, findRenderer);
        };
        findRenderer(node);
    }
    ts.forEachChild(node, visit);
};
visit(ast);

test('scroll renders skip the row hydration provider; releasing hydration preserves the mounted row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let providerCalls = 0;
    let mounts = 0;
    const Provider: typeof MarkdownHydrationProvider = (props) => {
        providerCalls += 1;
        return <MarkdownHydrationProvider {...props} />;
    };
    const Row = ({ message, onMessageContentChange }: { message: string; onMessageContentChange: () => void }) => {
        const hydrated = React.useContext(MarkdownHydrationContext);
        React.useEffect(() => { mounts += 1; }, []);
        return <button onClick={onMessageContentChange}>{hydrated ? message : 'placeholder'}</button>;
    };
    const compiled = ts.transpileModule(`${entryDeclaration}
        return function Surface({ entry, hydrateMarkdown, onMessageContentChange }) {
            const getAnimationHandlers = noop, scrollToBottom = noop, stickyUserHeader = false;
            const activityRenderMode = 'collapsed', turnUiStates = states, onToggleTurnGroup = noop;
            const chatRenderMode = 'live', shouldAnimateUserMessage = noop, onUserAnimationConsumed = noop;
            const reviewTransferDirection = null;
            ${historyRenderer}
            return renderEntry(entry, hydrateMarkdown);
        }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    const Surface = new Function('React', 'MarkdownHydrationProvider', 'UngroupedMessageRow', 'TurnBlock', 'StatusRowContainer', 'useRenderPhaseCallback', 'noop', 'states', compiled)(
        React, Provider, Row, Row, () => null, (fn: unknown) => fn, () => {}, new Map(),
    ) as React.ComponentType<{ entry: object; hydrateMarkdown: boolean; onMessageContentChange: () => void }>;
    const host = document.createElement('div');
    const root = createRoot(host);
    const entry = { kind: 'ungrouped', key: 'row', message: 'rendered Markdown' };
    const callback = vi.fn();
    const render = async (enabled: boolean, onChange = callback) => {
        await act(async () => root.render(<Surface entry={entry} hydrateMarkdown={enabled} onMessageContentChange={onChange} />));
    };
    try {
        await render(false);
        const node = host.querySelector('button');
        expect(node?.textContent).toBe('placeholder');
        providerCalls = 0;
        for (let i = 0; i < 50; i += 1) await render(false);
        expect(providerCalls).toBe(0);
        await render(true);
        expect(providerCalls).toBe(1);
        expect(host.querySelector('button')).toBe(node);
        expect(node?.textContent).toBe('rendered Markdown');
        const latest = vi.fn();
        await render(true, latest);
        await act(async () => node!.click());
        expect(latest).toHaveBeenCalledOnce();
        expect(callback).not.toHaveBeenCalled();
        expect(mounts).toBe(1);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});
