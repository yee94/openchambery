import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEvent, useEventListener } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
let resizeListener = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), `const ${node.getText(ast)};`);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEventListener'
        && node.arguments[1]?.getText(ast) === 'updateAutocompleteOverlayPosition') resizeListener = `${node.getText(ast)};`;
    ts.forEachChild(node, visit);
};
visit(ast);

function surface<Props extends object>(body: string, scope: Record<string, unknown>): React.ComponentType<Props> {
    const compiled = ts.transpileModule(`const Surface = (props) => { ${body} };`, {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function('React', 'useEvent', 'useEventListener', ...Object.keys(scope), `${compiled}\nreturn Surface;`)(React, useEvent, useEventListener, ...Object.values(scope));
}
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

it('selects the new draft during render and retains selector identity across unrelated renders', async () => {
    const state = { drafts: { a: { text: 'first' }, b: { text: 'second' } } };
    type Selector = (value: typeof state) => { text: string } | undefined;
    const selectors: Selector[] = [];
    const Surface = surface<{ draft: string }>(`
        const primaryDraftKeyID = props.draft;
        ${declarations.get('primaryDraftRecord')}
        return React.createElement('span', null, primaryDraftRecord?.text);
    `, { useInputStore: (selector: Selector) => { selectors.push(selector); return selector(state); } });
    await act(async () => root.render(<Surface draft="a" />));
    const firstSelector = selectors.at(-1);
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Surface draft="a" />));
    expect(selectors.every((selector) => selector === firstSelector)).toBe(true);
    await act(async () => root.render(<Surface draft="b" />));
    expect(host.textContent).toBe('second');
    expect(selectors.at(-1)).not.toBe(firstSelector);
});

it('retains the autocomplete resize listener across typing and reads the latest event-time state', async () => {
    expect(resizeListener).not.toBe('');
    const setPosition = vi.fn();
    const Surface = surface<{ expanded: boolean; message: string; show: boolean }>(`
        const { expanded: isDesktopExpanded, message, show: showFileMention } = props;
        const showCommandAutocomplete = false;
        ${declarations.get('updateAutocompleteOverlayPosition')}
        ${resizeListener}
        return null;
    `, {
        setAutocompleteOverlayPosition: setPosition,
        textareaRef: { current: { selectionStart: 0, scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, left: 0 }) } },
        dropZoneRef: { current: { getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }) } },
        measureCaretInTextarea: () => ({ top: 30, left: 40 }),
    });
    await act(async () => root.render(<Surface expanded message="" show={false} />));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Surface expanded message={'x'.repeat(i)} show={false} />));
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(<Surface expanded message="@file" show />));
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ place: 'below' }));
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(<Surface expanded={false} message="@file" show />));
    expect(remove.mock.calls.map(([type]) => String(type))).toContain('resize');
    setPosition.mockClear();
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(setPosition).not.toHaveBeenCalled();
});
