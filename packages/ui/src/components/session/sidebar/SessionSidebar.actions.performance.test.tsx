import React, { act } from 'react';
import { useEvent } from '@reactuses/core';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

test('project actions preserve the memo boundary through 50 catalog updates and use the latest loader', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SessionSidebar.tsx'), 'utf8');
    const ast = ts.createSourceFile('SessionSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration = '';
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'toggleProject') declaration = `const ${node.getText(ast)};`;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    let calls = 0;
    const Leaf = React.memo(({ onClick }: { onClick: (id: string) => void }) => {
        calls++;
        return <button onClick={() => onClick('project')}>toggle</button>;
    });
    const compiled = ts.transpileModule(`return function Surface({ ensureProjectSessionsLoaded }) {
        const ignoreIntersectionUntil = React.useRef(0);
        const [collapsedProjects, setCollapsedProjects] = React.useState(() => new Set(['project']));
        const resetProjectSessionLimits = noop, safeStorage = storage, isVSCode = false;
        const scheduleCollapsedProjectsPersist = noop, PROJECT_COLLAPSE_STORAGE_KEY = 'collapse';
        ${declaration}
        return React.createElement(Leaf, { onClick: toggleProject });
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const Surface = new Function('React', 'useEvent', 'noop', 'storage', 'Leaf', compiled)(React, useEvent, () => {}, { setItem: () => {} }, Leaf);
    const host = document.createElement('div');
    const root = createRoot(host);
    const loads = vi.fn();
    try {
        await act(async () => root.render(<Surface ensureProjectSessionsLoaded={() => loads(0)} />));
        calls = 0;
        for (let i = 1; i <= 50; i++) {
            await act(async () => root.render(<Surface ensureProjectSessionsLoaded={() => loads(i)} />));
        }
        expect(calls).toBe(0);
        await act(async () => host.querySelector('button')!.click());
        expect(loads).toHaveBeenCalledExactlyOnceWith(50);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});
