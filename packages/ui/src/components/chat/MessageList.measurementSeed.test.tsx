import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'), 'utf8');
const ast = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let buildSeed = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'buildMeasurementSeedFromSizes') {
        buildSeed = `const ${node.getText(ast)};`;
    }
    ts.forEachChild(node, visit);
};
visit(ast);
const boundary = source.slice(source.indexOf('    const unvirtualizedSizesRef'), source.indexOf('    // A zero initial viewport'));
type Seed = Array<{ key: string; size: number; start: number; end: number }>;
type Props = { virtualized: boolean; initial?: Seed; keys: string[]; content: HTMLDivElement; capture: (seed: Seed | undefined) => void };
const compiled = ts.transpileModule(`${buildSeed}
return function Surface(props) {
    const isTanstack = props.virtualized;
    const contentRef = { current: props.content };
    const entryKeys = props.keys;
    const initialMeasurements = props.initial;
    const estimatedEntrySizeRef = { current: 320 };
    ${boundary}
    React.useLayoutEffect(() => props.capture(measurementSeedRef.current));
    return null;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const Surface = new Function('React', compiled)(React) as React.ComponentType<Props>;

test('normal-flow commits do no seed measurements; virtualization adopts current fractional heights once', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const content = document.createElement('div');
    content.innerHTML = '<div data-turn-entry="old-a"></div><div data-turn-entry="old-b"></div>';
    let height = 180.25;
    const reads = [...content.children].map((node, index) => vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
        () => ({ height: height + index * 100 } as DOMRect),
    ));
    let seed: Seed | undefined;
    const capture = (value: Seed | undefined) => { seed = value; };
    const render = async (virtualized: boolean, initial?: Seed) => {
        await act(async () => root.render(<Surface virtualized={virtualized} initial={initial}
            keys={['new', 'old-a', 'old-b']} content={content} capture={capture} />));
    };
    try {
        for (let index = 0; index < 50; index += 1) await render(false);
        expect(reads.map(read => read.mock.calls.length)).toEqual([0, 0]);
        // Late content/width changes after the last commit must be reflected at adoption.
        height = 260.5;
        await render(true);
        expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1]);
        expect(seed?.map(item => [item.key, item.start, item.size])).toEqual([
            ['new', 0, 320], ['old-a', 320, 260.5], ['old-b', 580.5, 360.5],
        ]);
        const firstSeed = seed;
        for (let index = 0; index < 50; index += 1) await render(true);
        expect(seed).toBe(firstSeed);
        expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1]);
        await render(false);
        height = 300.75;
        await render(true);
        expect(seed?.[1].size).toBe(300.75);
        expect(reads.map(read => read.mock.calls.length)).toEqual([2, 2]);
        await render(false);
        const restored: Seed = [{ key: 'old-a', start: 0, size: 400, end: 400 }];
        await render(true, restored);
        expect(seed).toBe(restored);
        expect(reads.map(read => read.mock.calls.length)).toEqual([2, 2]);
    } finally {
        await act(async () => root.unmount());
        reads.forEach(read => read.mockRestore());
        vi.unstubAllGlobals();
    }
});
