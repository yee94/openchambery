import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ToolPart } from '@/lib/opencode/v2-types';
import type { TranscriptData } from '@/sync/transcript-repository';
import { ChildStoreManager } from '@/sync/child-store';

const fixture = vi.hoisted(() => ({ data: undefined as unknown as TranscriptData, renders: 0,
    listShells: vi.fn(async () => ({ data: [] as Array<{ id: string; status: string; metadata: { sessionID: string } }> })),
    stop: vi.fn(async () => {}), removeShell: vi.fn(async () => {}),
    output: vi.fn(async () => ({ data: { output: 'background log', truncated: false, cursor: 14, size: 14 } })),
}));
vi.mock('@/sync/session-actions', async (original) => ({
    ...await original<typeof import('@/sync/session-actions')>(), abortCurrentOperation: fixture.stop,
}));
vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => {
    fixture.renders += 1;
    return { t: (key: string, values?: { count?: number; title?: string }) => values?.count !== undefined
        ? `${values.count} 个后台任务运行中` : values?.title ? `${key}: ${values.title}` : key };
} }));
vi.mock('@/sync/transcript-repository-observers', async (original) => ({
    ...await original<typeof import('@/sync/transcript-repository-observers')>(),
    useTranscriptProjection: (_id: string, _directory: string, _store: unknown, project: (data: TranscriptData) => unknown) => project(fixture.data),
}));
import TurnItem from './components/TurnItem';
import type { TurnRecord } from './lib/turns/types';
import { opencodeClient } from '@/lib/opencode/client';
import { backgroundShellQueryOptions } from '@/queries/backgroundShellQueries';
import { useUIStore } from '@/stores/useUIStore';
import { BackgroundWorkHint } from './BackgroundWorkHint';
import { SessionSurfaceContext, PRIMARY_SESSION_SURFACE, STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES } from './SessionSurfaceContext';

let root: ReturnType<typeof createRoot> | undefined;
let queryClient: QueryClient;
let previousUI: ReturnType<typeof useUIStore.getState>;
const openPanel = vi.fn();
beforeEach(() => {
    previousUI = useUIStore.getState();
    useUIStore.setState({ isMobile: false, openContextPanelTab: openPanel });
    openPanel.mockClear();
    fixture.stop.mockClear();
    fixture.listShells.mockReset().mockResolvedValue({ data: [] });
    fixture.removeShell.mockReset().mockResolvedValue(undefined);
    fixture.output.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(opencodeClient, 'getScopedSdkClient').mockReturnValue({ shell: {
        list: fixture.listShells, remove: fixture.removeShell, output: fixture.output,
    } } as unknown as ReturnType<typeof opencodeClient.getScopedSdkClient>);
});

test('shells use live authority, expand logs on demand, and respect read-only surfaces', async () => {
    const childStores = new ChildStoreManager();
    childStores.ensureChild('/workspace', { bootstrap: false });
    const shell = task('shell-part', 'parent', 'completed', 'shell');
    shell.state = { ...shell.state, input: { command: 'build project' }, metadata: { shellID: 'shell-live', status: 'running' } };
    fixture.data = { messageOrder: ['message'], partsByMessageID: { message: [shell] } } as unknown as TranscriptData;
    fixture.listShells.mockResolvedValue({ data: [{ id: 'shell-live', status: 'running', metadata: { sessionID: 'parent' } }] });
    const context = (globalThis as Record<string, unknown>).__openchamber_sync_context__ as React.Context<{
        childStores: ChildStoreManager; sdk: unknown; directory: string;
    } | null>;
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const render = (readOnly: boolean) => root!.render(
        <QueryClientProvider client={queryClient}><context.Provider value={{ childStores, sdk: {}, directory: '/workspace' }}>
            <SessionSurfaceContext.Provider value={{ ...PRIMARY_SESSION_SURFACE,
                capabilities: readOnly ? STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES : PRIMARY_SESSION_SURFACE.capabilities }}>
                <BackgroundWorkHint sessionID="parent" directory="/workspace" />
            </SessionSurfaceContext.Provider>
        </context.Provider></QueryClientProvider>,
    );
    await act(async () => render(true));
    await act(async () => { await queryClient.ensureQueryData(backgroundShellQueryOptions('/workspace', ['shell-live'])); });
    await vi.waitFor(async () => { await act(async () => {}); expect(host.textContent).toBe('1 个后台任务运行中'); });
    expect(fixture.output).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(host.querySelector('[aria-label^="mobile.sessions.stopSessionAria"]')).toBeNull();
    await act(async () => host.querySelector<HTMLElement>('[data-background-task] [role="button"]')!.click());
    expect(fixture.output).toHaveBeenCalledWith(
        { id: 'shell-live', location: { directory: '/workspace' }, limit: 65_536 }, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => render(false));
    fixture.removeShell.mockRejectedValueOnce(new Error('offline'));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="mobile.sessions.stopSessionAria: build project"]')!.click());
    expect(host.querySelector('[data-background-task="shell-live"]')).not.toBeNull();
    fixture.removeShell.mockImplementationOnce(async () => { fixture.listShells.mockResolvedValue({ data: [] }); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="mobile.sessions.stopSessionAria: build project"]')!.click());
    expect(fixture.removeShell).toHaveBeenCalledWith({ id: 'shell-live', location: { directory: '/workspace' } });
    await act(async () => { await queryClient.refetchQueries({ queryKey: backgroundShellQueryOptions('/workspace', ['shell-live']).queryKey }); });
    await vi.waitFor(async () => { await act(async () => {}); expect(host.querySelector('[role="status"]')).toBeNull(); });
});
afterEach(() => { act(() => root?.unmount()); queryClient.clear(); useUIStore.setState(previousUI); vi.restoreAllMocks(); document.body.innerHTML = ''; });
afterAll(() => vi.unstubAllGlobals());

const task = (id: string, child: string, status = 'completed', tool = 'subagent'): ToolPart => ({
    id, type: 'tool', tool, sessionID: 'parent', messageID: 'message', callID: id,
    state: { status, input: { background: true, agent: 'explore', description: `Task ${child}` }, metadata: { sessionID: child, status: 'running' } },
} as ToolPart);

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
    const turn = {
        turnId: 'turn-parent',
        userMessage: { info: { id: 'user', sessionID: 'parent', role: 'user', time: { created: 1 } }, parts: [], sourceDirectory: '/workspace' },
        assistantMessages: [],
        messages: [],
    } as unknown as TurnRecord;
    await act(async () => root!.render(
        <QueryClientProvider client={queryClient}><context.Provider value={{ childStores, sdk: {}, directory: '/workspace' }}>
            <TurnItem turn={turn} activityExpanded={false} showCompactionStatus={false}
                showBackgroundWork onToggleActivity={() => {}} renderMessage={() => null} />
        </context.Provider></QueryClientProvider>,
    ));
    expect(host.textContent).toBe('2 个后台任务运行中');
    const section = host.querySelector('[data-turn-id="turn-parent"]');
    expect(section?.classList.contains('pb-8')).toBe(true);
    expect(section?.querySelector('.group\\/message > [role="status"]')?.textContent).toBe('2 个后台任务运行中');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-agent-avatar]')).toHaveLength(2);
    await act(async () => { await queryClient.ensureQueryData(backgroundShellQueryOptions('/workspace', ['shell'])); });
    const renders = fixture.renders;
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, unrelated: { type: 'busy' } } })));
    expect(fixture.renders).toBe(renders);
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child1: { type: 'idle' } } })));
    expect(host.textContent).toBe('1 个后台任务运行中');
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-background-task="child2"]')).not.toBeNull();
    expect(host.textContent).toContain('Task child2');
    expect(host.querySelector('[data-background-task="child2"] [data-agent-avatar]')).not.toBeNull();
    const taskRow = host.querySelector<HTMLElement>('[data-background-task="child2"] [data-agent-avatar]')!;
    await act(async () => taskRow.click());
    expect(openPanel).toHaveBeenCalledWith('/workspace', expect.objectContaining({ mode: 'chat', dedupeKey: 'session:child2' }));
    const stop = host.querySelector<HTMLButtonElement>('[aria-label="mobile.sessions.stopSessionAria: Task child2"]')!;
    await act(async () => stop.click());
    expect(fixture.stop).toHaveBeenCalledWith('child2');
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child2: { type: 'idle' } } })));
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => children.setState((state) => ({ session_status: { ...state.session_status, child1: { type: 'busy' } } })));
    expect(host.textContent).toBe('1 个后台任务运行中');
});
