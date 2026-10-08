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

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
afterAll(() => { vi.unstubAllGlobals(); });

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
