import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Execute the production render branches, isolating transcript/data hooks from DOM reconciliation.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ChatContainer.tsx'), 'utf8');
const ast = ts.createSourceFile('ChatContainer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let branches = '';
let prompt = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'promptSurface' && node.initializer) {
        prompt = `const promptSurface = ${node.initializer.getText(ast)};`;
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'ChatContainerContent'
        && node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
        const statements = node.initializer.body.statements;
        const start = statements.findIndex((statement) => ts.isIfStatement(statement)
            && statement.expression.getText(ast) === 'hasSessionHistoryLoadError');
        branches = statements.slice(start).map((statement) => statement.getText(ast)).join('\n');
    }
    ts.forEachChild(node, visit);
};
visit(ast);
if (!branches || !prompt) throw new Error('Missing session render branches');
branches = `${prompt}\n${branches}`;
const branchAst = ts.createSourceFile('branches.tsx', branches, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const bindings = new Set<string>(['React']);
const collect = (node: ts.Node) => {
    if (ts.isIdentifier(node) && /^[A-Za-z_$][\w$]*$/.test(node.text)) bindings.add(node.text);
    ts.forEachChild(node, collect);
};
collect(branchAst);
bindings.delete('promptSurface');
const compiled = ts.transpileModule(`const renderBranch = () => { ${branches} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None },
}).outputText;
const createRender = new Function(...bindings, `${compiled}\nreturn renderBranch;`);
const Empty = () => null;
const Composer = () => <textarea defaultValue="loading draft" autoFocus />;
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

const render = async (overrides: Record<string, unknown>) => {
    const scope: Record<string, unknown> = {
        React, cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
        currentSessionId: 'session', isMobile: false, isDesktopExpandedInput: false,
        hasSessionHistoryLoadError: false, isSessionHydrating: false, sessionIsWorking: false,
        renderedViewportMessages: [{}], HYDRATING_SKELETON_ITEMS: [],
        timelineController: { historySignals: {} }, navigation: {},
        promptAvailability: {}, ChatInput: Composer,
        t: (key: string) => key,
        ChatViewport: Empty, Skeleton: Empty, DesktopComposerEdgeFade: Empty,
        ImageSaveActionsHost: Empty, TimelineDialog: Empty, ScrollToBottomButton: Empty,
        ChatEmptyState: Empty, Icon: Empty, Button: Empty,
        ...overrides,
    };
    const RenderBranch = createRender(...Array.from(bindings, (key) => scope[key]));
    // Keep the parent component identity stable across the production branch transition.
    await act(async () => root.render(RenderBranch()));
};

describe('session loading composer continuity', () => {
    test.each([
        { isMobile: false, isDesktopExpandedInput: false },
        { isMobile: true, isDesktopExpandedInput: false },
        { isMobile: false, isDesktopExpandedInput: true },
    ])('preserves typing and selection when history arrives ($isMobile, $isDesktopExpandedInput)', async (layout) => {
        await render({ ...layout, isSessionHydrating: true });
        const textarea = host.querySelector('textarea')!;
        textarea.value = 'already typing during loading';
        textarea.focus();
        textarea.setSelectionRange(8, 14, 'backward');
        await render(layout);
        expect(host.querySelector('textarea')).toBe(textarea);
        expect(document.activeElement).toBe(textarea);
        expect(textarea.value).toBe('already typing during loading');
        expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([8, 14, 'backward']);
    });

    test('preserves the input through load failure, retry and empty history', async () => {
        await render({ isSessionHydrating: true });
        const textarea = host.querySelector('textarea')!;
        textarea.value = 'unsent text';
        textarea.setSelectionRange(3, 3);
        for (const state of [
            { hasSessionHistoryLoadError: true },
            { isSessionHydrating: true },
            { renderedViewportMessages: [] },
            { warning: 'partial history' },
        ]) {
            await render(state);
            expect(host.querySelector('textarea')).toBe(textarea);
            expect(textarea.value).toBe('unsent text');
            expect(textarea.selectionStart).toBe(3);
        }
    });

    test('keeps a collapsed caret when scroll controls and warnings appear', async () => {
        await render({ isSessionHydrating: true });
        const textarea = host.querySelector('textarea')!;
        textarea.value = 'before after';
        textarea.setSelectionRange(7, 7);
        await render({ warning: 'partial history', timelineController: { historySignals: {}, showScrollToBottom: true } });
        expect(host.querySelector('textarea')).toBe(textarea);
        expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 7]);
        textarea.setRangeText('inserted ', textarea.selectionStart, textarea.selectionEnd, 'end');
        expect(textarea.value).toBe('before inserted after');
    });
});
