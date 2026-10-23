import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, test } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'), 'utf8');
const ast = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: string[] = [];
const wanted = new Set([
    'isInsideStuckSticky',
    'findMessageElement',
    'captureViewportMessageAnchor',
    'captureLastMessageAnchor',
    'captureVirtualizationTransitionAnchor',
]);
let handleCapture = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent.parent.parent)
        && wanted.has(node.name.getText(ast))) {
        declarations.push(`const ${node.getText(ast)};`);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'captureViewportAnchor') {
        handleCapture = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
};
visit(ast);

type Anchor = { messageId: string; offsetTop: number; entryKey?: string };
const compiled = ts.transpileModule(`${declarations.join('\n')}
return {
    captureVirtualizationTransitionAnchor,
    handleCapture: (resolveScrollContainer) => (${handleCapture})(),
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const api = new Function(compiled)() as {
    captureVirtualizationTransitionAnchor: (content: HTMLElement, container: HTMLElement) => Anchor | null;
    handleCapture: (resolveScrollContainer: () => HTMLElement | null) => Anchor | null;
};

const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
}) as DOMRect;

const place = (element: Element, top: number, height: number) => {
    (element as HTMLElement).getBoundingClientRect = () => rect(top, height);
};

afterEach(() => {
    document.body.innerHTML = '';
});

test('threshold transition anchors on the last history message when the reader is in the live tail', () => {
    // Viewport 0..700. Every history message sits above it: the reader looks
    // at the live tail, which is outside the history content root.
    const container = document.createElement('div');
    const content = document.createElement('div');
    content.innerHTML = '<div data-turn-entry="a"><div data-message-id="m1"></div></div>'
        + '<div data-turn-entry="b"><div data-message-id="m2"></div></div>';
    container.appendChild(content);
    document.body.appendChild(container);
    place(container, 0, 700);
    place(content, -1200, 1180);
    const [entryA, entryB] = content.querySelectorAll('[data-turn-entry]');
    place(entryA, -1200, 600);
    place(entryA.firstElementChild!, -1200, 600);
    place(entryB, -600, 580);
    place(entryB.firstElementChild!, -600, 580);

    const anchor = api.captureVirtualizationTransitionAnchor(content, container);

    // Without an anchor the virtualizer's initial offset falls back to the
    // raw scrollTop and the virtual padding shifts the whole viewport.
    expect(anchor).toMatchObject({ messageId: 'm2', offsetTop: -600, entryKey: 'b', entryStart: 600 });
});

test('viewport anchor prefers a message starting inside the viewport over one straddling the top edge', () => {
    // A tall assistant message straddles the top edge; when its Markdown
    // hydrates it shrinks internally while its top stays put, so it cannot
    // detect the shift the reader sees below it.
    const container = document.createElement('div');
    container.innerHTML = '<div data-message-id="straddling"></div><div data-message-id="reading"></div>';
    document.body.appendChild(container);
    place(container, 0, 700);
    const [straddling, reading] = container.querySelectorAll('[data-message-id]');
    place(straddling, -354, 400);
    place(reading, 46, 300);

    expect(api.handleCapture(() => container)).toEqual({ messageId: 'reading', offsetTop: 46 });
});

test('viewport anchor falls back to the straddling message when no message starts in view', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div data-message-id="above"></div><div data-message-id="tall"></div>';
    document.body.appendChild(container);
    place(container, 0, 700);
    const [above, tall] = container.querySelectorAll('[data-message-id]');
    place(above, -900, 400);
    place(tall, -500, 2000);

    expect(api.handleCapture(() => container)).toEqual({ messageId: 'tall', offsetTop: -500 });
});
