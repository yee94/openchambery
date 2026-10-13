import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SessionStatus, ToolPart as ToolPartType } from '@/lib/opencode/v2-types';

const live = vi.hoisted(() => ({ store: undefined as unknown as StoreApi<{ status: SessionStatus }>, messages: [] as unknown[] }));
vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/sync/sync-context', async () => {
    const { useStore } = await import('zustand');
    return {
        useSession: () => undefined,
        useSessionMessageRecords: () => live.messages,
        useEnsureSessionMessages: () => undefined,
        useSessionStatus: (id: string) => useStore(live.store, (state) => id ? state.status : undefined),
        useGlobalSessionStatus: (id: string) => useStore(live.store, (state) => id ? state.status : undefined),
        useSessionStatusObservedAt: () => 200,
        useSessionStatusSnapshotAt: () => 200,
    };
});
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('../../MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => null }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: () => null }));
vi.mock('@pierre/diffs/react', () => ({ PatchDiff: () => null }));

import ToolPart from './ToolPart';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';
import { applyTranscriptDirectoryEvent, type TranscriptEventDraft } from '@/sync/transcript-event-reducer';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllGlobals(); });

test.each(['completed', 'error'])('tool elapsed time survives projection, remount and %s settlement', async (status) => {
    live.store = createStore(() => ({ status: { type: 'busy' } as SessionStatus }));
    live.messages = [];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(11_000);
    const project = (time: Record<string, number>, toolStatus = 'running') => {
        const row = normalizeSessionProjectionMessage('ses_parent', {
            id: 'msg_parent', type: 'assistant', time: { created: 500 },
            content: [{ type: 'tool', id: 'tool-clock', name: 'shell', time,
                state: { status: toolStatus, input: { command: 'pwd' }, metadata: {} } }],
        })!;
        return row.parts[0] as ToolPartType;
    };
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const render = async (part: ToolPartType) => {
        await act(async () => root!.render(<ToolPart part={part} isExpanded={false} onToggle={() => {}} isMobile={false} />));
    };
    await render(project({ created: 500, ran: 1_000 }));
    expect(host.textContent).toContain('10.0s');
    await act(async () => root!.render(null));
    clock.mockReturnValue(16_000);
    await render(project({ created: 500, ran: 1_000 }));
    expect(host.textContent).toContain('15.0s');
    await render(project({ created: 500, ran: 1_000, completed: 13_000 }, status));
    expect(host.textContent).toContain('12.0s');
});

test.each(['session.tool.success', 'session.tool.failed'])('late live tool timing replaces missing timing and stays fixed after %s', async (terminalEvent) => {
    live.store = createStore(() => ({ status: { type: 'busy' } as SessionStatus }));
    live.messages = [];
    vi.spyOn(Date, 'now').mockReturnValue(11_000);
    const state: TranscriptEventDraft = { message: {}, part: {} };
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const event = async (type: string, eventCreated: number) => {
        applyTranscriptDirectoryEvent(state, { type, properties: {
            sessionID: 'ses_parent', assistantMessageID: 'msg_parent', id: 'tool-clock',
            name: 'shell', input: { command: 'pwd' }, eventCreated,
        } });
        const part = state.part.msg_parent[0] as ToolPartType;
        await act(async () => root!.render(<ToolPart part={part} isExpanded={false} onToggle={() => {}} isMobile={false} />));
    };
    await event('session.tool.input.started', 500);
    expect(host.textContent).not.toMatch(/\d+\.\ds/);
    await event('session.tool.called', 1_000);
    expect(host.textContent).toContain('10.0s');
    await event(terminalEvent, 9_000);
    expect(host.textContent).toContain('8.0s');
});

test.each([false, true])('background child follows session status across repeated executions (mobile=%s)', async (isMobile) => {
    live.store = createStore(() => ({ status: { type: 'idle' } as SessionStatus }));
    live.messages = [{
        info: { role: 'user' },
        parts: [{ type: 'text', text: '<subagent sessionID="ses_child" state="completed">Previous run finished</subagent>' }],
    }];
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const part = {
        id: 'tool-background', sessionID: 'ses_parent', messageID: 'msg_parent',
        type: 'tool', tool: 'subagent', callID: 'call-background',
        state: {
            status: 'completed', input: { agent: 'explore', background: true },
            metadata: { sessionID: 'ses_child', status: 'running' },
            output: 'The subagent is working in the background.', title: 'Explore',
            time: { start: 100, end: 110 },
        },
    } as ToolPartType;
    await act(async () => root!.render(<ToolPart part={part} isExpanded={false} onToggle={() => {}} isMobile={isMobile} />));
    expect(host.querySelector('.animate-text-shimmer')).toBeNull();
    await act(async () => live.store.setState({ status: { type: 'busy' } }));
    expect(host.querySelector('.animate-text-shimmer')).not.toBeNull();
    await act(async () => live.store.setState({ status: { type: 'retry', attempt: 1, message: 'Retrying', next: 500 } }));
    expect(host.querySelector('.animate-text-shimmer')).not.toBeNull();
    await act(async () => live.store.setState({ status: { type: 'idle' } }));
    expect(host.querySelector('.animate-text-shimmer')).toBeNull();
    await act(async () => live.store.setState({ status: { type: 'busy' } }));
    expect(host.querySelector('.animate-text-shimmer')).not.toBeNull();
});
