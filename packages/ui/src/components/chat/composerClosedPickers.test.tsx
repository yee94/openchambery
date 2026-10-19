import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BranchSelector } from '../views/git/BranchSelector';

const presence = vi.hoisted(() => ({ visible: false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
    DropdownMenuContent: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
}));
vi.mock('@/components/ui/MobileResizableSheet', () => ({
    MobileResizableSheet: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
}));

const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); presence.visible = false; });

describe('closed composer picker work', () => {
    test.each(['dropdown', 'mobile-sheet'] as const)('%s does not enumerate branches on repeated composer renders', async (presentation) => {
        const localBranches = Array.from({ length: 300 }, (_, i) => `local-${i}`);
        const remoteBranches = Array.from({ length: 300 }, (_, i) => `remote-${i}`);
        const localMap = vi.spyOn(localBranches, 'map');
        const remoteMap = vi.spyOn(remoteBranches, 'map');
        const worktreeOptions = Array.from({ length: 300 }, (_, i) => ({ value: `/tree-${i}`, label: `tree-${i}` }));
        const worktreeMap = vi.spyOn(worktreeOptions, 'map');
        const onCheckout = vi.fn();
        const render = () => root.render(<BranchSelector
            currentBranch="main" localBranches={localBranches} remoteBranches={remoteBranches}
            branchInfo={{}} onCheckout={onCheckout} onCreate={async () => {}}
            worktreeOptions={worktreeOptions} onSelectDirectory={() => {}}
            hideTooltip open={presence.visible} presentation={presentation}
        />);
        for (let i = 0; i < 20; i++) {
            await act(async () => render());
        }
        expect(localMap.mock.calls.length).toBe(0);
        expect(remoteMap.mock.calls.length).toBe(0);
        expect(worktreeMap.mock.calls.length).toBe(0);
        presence.visible = true;
        await act(async () => render());
        expect(host.textContent).toContain('local-299');
        expect(host.textContent).toContain('remote-299');
        expect(host.textContent).toContain('tree-299');
        const row = Array.from(host.querySelectorAll('[cmdk-item]')).find((element) => element.textContent === 'local-1');
        expect(row).toBeDefined();
        await act(async () => (row as HTMLElement).click());
        expect(onCheckout).toHaveBeenCalledWith('local-1');
        presence.visible = false;
        localMap.mockClear(); remoteMap.mockClear(); worktreeMap.mockClear();
        for (let i = 0; i < 20; i++) await act(async () => render());
        expect(localMap.mock.calls.length + remoteMap.mock.calls.length + worktreeMap.mock.calls.length).toBe(0);
    });

    // Execute the production desktop project popup at its JSX boundary, just as
    // ChatInput's render-branch tests do, without bootstrapping session transport.
    test.each(['desktop', 'mobile'])('closed %s project popup never builds project labels during typing', async (mode) => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
        const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let popup = '';
        let items = '';
        const visit = (node: ts.Node) => {
            if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'SelectContent'
                && node.getText(ast).includes('desktopDraftProjectQuery') && mode === 'desktop') popup = node.getText(ast);
            if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'MobileResizableSheet'
                && node.getText(ast).includes('mobile-draft-project-picker-sheet') && mode === 'mobile') popup = node.getText(ast);
            if (ts.isFunctionDeclaration(node) && node.name?.text === 'DraftProjectItems') items = node.getText(ast);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(popup).not.toBe('');
        const renderProjectLabelWithIcon = vi.fn(() => 'project');
        const projects = Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, path: `/project-${i}` }));
        const enumerateProjects = vi.spyOn(projects, 'filter');
        const scope = {
            React, projects, renderProjectLabelWithIcon, desktopDraftProjectQuery: '',
            SelectContent: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
            MobileResizableSheet: ({ children }: React.PropsWithChildren) => presence.visible ? <>{children}</> : null,
            ScrollableOverlay: ({ children }: React.PropsWithChildren) => <>{children}</>,
            mobileDraftProjectSheetId: 'test', mobileDraftPicker: null, mobileDraftPickerQuery: '',
            setMobileDraftPicker: vi.fn(), setMobileDraftPickerQuery: vi.fn(),
            handleDraftProjectChange: vi.fn(), selectedDraftProject: projects[0],
            SelectItem: 'div', SelectSeparator: 'hr', Input: 'input', Icon: 'i',
            setDesktopDraftProjectQuery: vi.fn(), setDesktopDraftProjectPickerOpen: vi.fn(),
            t: (key: string) => key, matchesModelSearch: () => true,
            getProjectDisplayLabel: (project: { path: string }) => project.path,
        };
        const compiled = ts.transpileModule(`${items}\nconst Surface = () => (${popup});`, {
            compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        }).outputText;
        const Surface = new Function(...Object.keys(scope), `${compiled}\nreturn Surface;`)(...Object.values(scope));
        for (let i = 0; i < 20; i++) await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(0);
        expect(enumerateProjects.mock.calls.length).toBe(0);
        presence.visible = true;
        await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(300);
        expect(enumerateProjects.mock.calls.length).toBe(1);
        presence.visible = false;
        renderProjectLabelWithIcon.mockClear();
        enumerateProjects.mockClear();
        for (let i = 0; i < 20; i++) await act(async () => root.render(<Surface />));
        expect(renderProjectLabelWithIcon.mock.calls.length).toBe(0);
        expect(enumerateProjects.mock.calls.length).toBe(0);
    });
});
