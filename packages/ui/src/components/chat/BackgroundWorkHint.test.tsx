import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import type { TranscriptData } from '@/sync/transcript-repository';
import { ChildStoreManager } from '@/sync/child-store';

const fixture = vi.hoisted(() => ({ data: undefined as unknown as TranscriptData, renders: 0 }));
vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => {
    fixture.renders += 1;
    return { t: (_key: string, values: { count: number }) => `${values.count} 个后台任务运行中` };
} }));
vi.mock('@/sync/transcript-repository-observers', async (original) => ({
    ...await original<typeof import('@/sync/transcript-repository-observers')>(),
    useTranscriptProjection: (_id: string, _directory: string, _store: unknown, project: (data: TranscriptData) => unknown) => project(fixture.data),
}));
import { BackgroundWorkHint } from './BackgroundWorkHint';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
afterAll(() => vi.unstubAllGlobals());

const task = (id: string, child: string, status = 'completed', tool = 'subagent'): Part => ({
    id, type: 'tool', tool, sessionID: 'parent', messageID: 'message', callID: id,
    state: { status, input: { background: true }, metadata: { sessionID: child, status: 'running' } },
} as Part);

test('counts unique live background children after parent idle and follows cross-directory completion', async () => {
    const childStores = new ChildStoreManager();
    const parent = childStores.ensureChild('/workspace', { bootstrap: false });
    const children = childStores.ensureChild('/other', { bootstrap: false });
    parent.setState({ session_status: { parent: { type: 'idle' } } });
    children.setState({ session_status: {
        child1: { type: 'busy' }, child2: { type: 'retry', attempt: 1, message: 'retry', next: 500 },
        foreground: { type: 'busy' }, shell: { type: 'busy' },
    } });
    fixture.data = {
        messageOrder: ['message'],
        partsByMessageID: { message: [
            task('a', 'child1'), task('duplicate', 'child1'), task('b', 'child2'),
            task('foreground', 'foreground', 'running'), task('shell', 'shell', 'completed', 'shell'),
            task('unknown', 'unknown'),
        ] },
    } as unknown as TranscriptData;
    const context = (globalThis as Record<string, unknown>).__openchamber_sync_context__ as React.Context<{
        childStores: ChildStoreManager; sdk: unknown; directory: string;
    } | null>;
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <context.Provider value={{ childStores, sdk: {}, directory: '/workspace' }}>
            <BackgroundWorkHint sessionID="parent" directory="/workspace" />
        </context.Provider>,
    ));
    expect(host.textContent).toBe('2 个后台任务运行中');
    const renders = fixture.renders;
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, unrelated: { type: 'busy' } } })));
    expect(fixture.renders).toBe(renders);
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child1: { type: 'idle' } } })));
    expect(host.textContent).toBe('1 个后台任务运行中');
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child2: { type: 'idle' } } })));
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child1: { type: 'busy' } } })));
    expect(host.textContent).toBe('1 个后台任务运行中');
});
