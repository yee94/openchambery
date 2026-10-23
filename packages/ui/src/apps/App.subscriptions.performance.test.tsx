import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

test('App ignores session identity and draft edits until the directory bootstrap policy changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
    const start = source.indexOf('  const error = useSessionUIStore');
    const boundary = source.slice(start, source.indexOf('  const currentDirectory', start));
    const useStore = create(() => ({ currentSessionId: 'first' as string | null,
        newSessionDraft: { open: false, directory: '/first' }, error: null, clearError: () => {} }));
    let renders = 0;
    const compiled = ts.transpileModule(`return function Surface() {
        ${boundary}
        record();
        return React.createElement('span', null, String(typeof bootstrapDirectory !== 'undefined'
            ? bootstrapDirectory : !(newSessionDraftOpen && currentSessionId === null)));
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const Surface = new Function('React', 'useSessionUIStore', 'record', compiled)(React, useStore, () => renders++);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Surface />));
        renders = 0;
        for (let i = 0; i < 50; i++) {
            await act(async () => useStore.setState({ currentSessionId: `session-${i}`, newSessionDraft: { open: false, directory: `/project-${i}` } }));
        }
        expect(renders).toBe(0);
        expect(host.textContent).toBe('true');
        await act(async () => useStore.setState({ currentSessionId: null, newSessionDraft: { open: true, directory: '/draft' } }));
        expect(renders).toBe(1);
        expect(host.textContent).toBe('false');
        await act(async () => useStore.setState({ currentSessionId: 'selected' }));
        expect(host.textContent).toBe('true');
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});
