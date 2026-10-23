import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import * as indexApi from '@/lib/session-index-api';
import { queryClient } from '@/lib/queryRuntime';
import * as runtimeSwitch from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

vi.mock('@/stores/useDirectoryStore', async () => {
    const { create } = await import('zustand');
    return { useDirectoryStore: create(() => ({ currentDirectory: null })) };
});
vi.hoisted(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
});

const queryDefaults = queryClient.getDefaultOptions();
beforeEach(() => {
    getDeferredSafeStorage().removeItem('oc.sessionIndexStartupCache');
    queryClient.setDefaultOptions({ ...queryDefaults, queries: { ...queryDefaults.queries, retry: false } });
});
afterEach(() => {
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    queryClient.clear();
    queryClient.setDefaultOptions(queryDefaults);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test('failed hydrate releases its flight so startup can retry without a runtime reset', async () => {
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    queryClient.clear();
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(async () => new Response(JSON.stringify({ available: true, ...snapshot(1) })));
    vi.stubGlobal('fetch', fetch);
    await Promise.all([useGlobalSessionsStore.getState().hydrateSessionIndex(), useGlobalSessionsStore.getState().hydrateSessionIndex()]);
    expect(useGlobalSessionsStore.getState().hasHydratedSessionIndex).toBe(false);
    await useGlobalSessionsStore.getState().hydrateSessionIndex();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useGlobalSessionsStore.getState().hasHydratedSessionIndex).toBe(true);
});

test('startup tip projections run in background tasks and 50 equivalent snapshots notify nobody', async () => {
    const tasks: Array<() => void> = [];
    const priorities: string[] = [];
    vi.stubGlobal('scheduler', { postTask: (run: () => void, options: { priority: string; signal: AbortSignal }) => new Promise<void>((resolve) => {
        priorities.push(options.priority);
        tasks.push(() => { if (!options.signal.aborted) run(); resolve(); });
        options.signal.addEventListener('abort', () => resolve(), { once: true });
    }) });
    let tip: (() => void) | undefined;
    vi.spyOn(indexApi, 'waitForSessionIndexInvalidation').mockImplementation((_revision, signal) => new Promise((resolve) => {
        tip = () => resolve('ready');
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, ...snapshot(10) }))));
    await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo']);
    await vi.waitFor(() => expect(tasks.length).toBe(1));
    // A tip delivered while the background task is queued must survive the yield.
    expect(tip).toBeDefined();
    tip!(); tip = undefined;
    tasks.shift()!();
    await vi.waitFor(() => expect(tasks.length).toBe(1));
    tasks.shift()!();
    await vi.waitFor(() => expect(tip).toBeDefined());
    const before = useGlobalSessionsStore.getState();
    const notify = vi.fn();
    const unsubscribe = useGlobalSessionsStore.subscribe(notify);
    try {
        for (let i = 0; i < 50; i++) {
            tip!(); tip = undefined;
            await vi.waitFor(() => expect(tasks.length).toBe(1), { interval: 1 });
            expect(useGlobalSessionsStore.getState()).toBe(before);
            tasks.shift()!();
            await vi.waitFor(() => expect(tip).toBeDefined(), { interval: 1 });
        }
        expect(notify).toHaveBeenCalledTimes(0);
        expect(new Set(priorities)).toEqual(new Set(['background']));
        tip!();
        await vi.waitFor(() => expect(tasks.length).toBe(1), { interval: 1 });
        useGlobalSessionsStore.getState().resetForRuntimeSwitch();
        const reset = useGlobalSessionsStore.getState();
        tasks.shift()!();
        await Promise.resolve();
        expect(useGlobalSessionsStore.getState()).toBe(reset);
    } finally { unsubscribe(); }
});

test('pending-directory classification is linear in sessions, not directories times sessions', async () => {
    queryClient.clear();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    let directoryReads = 0;
    const sessions = Array.from({ length: 2000 }, (_, index) => ({
        id: `session-${index}`,
        title: `Session ${index}`,
        get directory() { directoryReads++; return '/repo/loaded'; },
        time: { created: index, updated: index },
    } as Session));
    const pendingDirectories = ['/repo/loaded', ...Array.from({ length: 300 }, (_, index) => `/repo/pending-${index}`)];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        available: true,
        revision: 1,
        directories: [],
        sync: { active: true, completed: 0, total: pendingDirectories.length, pendingDirectories, completedDirectories: [], failedDirectories: [] },
    }), { headers: { 'Content-Type': 'application/json' } })));
    useGlobalSessionsStore.getState().applySnapshot(sessions, []);
    directoryReads = 0;
    await useGlobalSessionsStore.getState().hydrateSessionIndex();
    const state = useGlobalSessionsStore.getState();
    expect(state.hasHydratedSessionIndex).toBe(true);
    expect(state.activeSessions).toHaveLength(2000);
    expect(state.sessionsByDirectory.get('/repo/loaded')).toHaveLength(2000);
    expect(state.refreshingDirectories.has('/repo/loaded')).toBe(true);
    expect(state.loadingDirectories.has('/repo/loaded')).toBe(false);
    expect(state.loadingDirectories.has('/repo/pending-299')).toBe(true);
    expect(directoryReads).toBeLessThan(sessions.length * 10);
});

const snapshot = (revision: number): SessionIndexSnapshot => ({
    revision,
    sync: { active: false, completed: 1, total: 1, pendingDirectories: [], completedDirectories: ['/repo'], failedDirectories: [] },
    directories: [{
        directory: '/repo', cursor: null, hasMore: false,
        lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1,
        sessions: Array.from({ length: 300 }, (_, index) => ({
            id: `session-${index}`, title: `Session ${index}`, directory: '/repo',
            time: { created: index, updated: index },
            metadata: { nested: { values: [1, 'two', null] } },
        })),
    }],
});

const applyIndex = async (value: SessionIndexSnapshot) => {
    // Use real HTTP parsing so every response contains fresh object references.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, ...value }), {
        headers: { 'Content-Type': 'application/json' },
    })));
    await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo']);
};

test('duplicate and newer equivalent index snapshots preserve all projection references', async () => {
    await applyIndex(snapshot(10));
    const before = useGlobalSessionsStore.getState();
    let listChanges = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe((next, previous) => {
        if (next.activeSessions !== previous.activeSessions) listChanges++;
    });
    try {
        await applyIndex(snapshot(10));
        await applyIndex(snapshot(11));
        const after = useGlobalSessionsStore.getState();
        for (const key of [
            'activeSessions', 'sessionsByDirectory', 'reviewTransferBySessionId',
            'loadedDirectories', 'loadingDirectories', 'refreshingDirectories',
            'activePaginationByDirectory', 'sessionIndexSyncByDirectory', 'cachedDirectories',
        ] as const) expect(after[key], key).toBe(before[key]);
        expect(listChanges).toBe(0);
    } finally { unsubscribe(); }
});

test('one nested session change replaces only that session', async () => {
    await applyIndex(snapshot(10));
    const before = useGlobalSessionsStore.getState().activeSessions;
    const next = snapshot(11);
    next.directories[0].sessions[42].metadata = { nested: { values: [1, 'changed', null] } };
    await applyIndex(next);
    const after = useGlobalSessionsStore.getState().activeSessions;
    expect(after.filter((session, index) => session === before[index])).toHaveLength(299);
    expect(after.find((session) => session.id === 'session-42')?.metadata).toEqual({ nested: { values: [1, 'changed', null] } });
});

test('late older index revision cannot overwrite a newer projection', async () => {
    const newer = snapshot(20);
    newer.directories[0].sessions[0].title = 'New title';
    await applyIndex(newer);
    const before = useGlobalSessionsStore.getState().activeSessions;
    await applyIndex(snapshot(19));
    expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
    expect(before.find((session) => session.id === 'session-0')?.title).toBe('New title');
});

test('runtime reset admits a lower index revision', async () => {
    await applyIndex(snapshot(20));
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    await applyIndex(snapshot(1));
    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(300);
});

test('capturing a changed runtime admits a lower revision even before store reset', async () => {
    const generation = vi.spyOn(runtimeSwitch, 'getRuntimeGeneration');
    generation.mockReturnValue(100);
    await applyIndex(snapshot(20));
    generation.mockReturnValue(101);
    const next = snapshot(1);
    next.directories[0].sessions[0].title = 'Other runtime';
    await applyIndex(next);
    expect(useGlobalSessionsStore.getState().activeSessions.find((session) => session.id === 'session-0')?.title)
        .toBe('Other runtime');
});

test('duplicate revision still releases observer loading without replacing rows', async () => {
    await applyIndex(snapshot(10));
    const before = useGlobalSessionsStore.getState().activeSessions;
    useGlobalSessionsStore.setState({ loadingDirectories: new Set(['/repo']), refreshingDirectories: new Set(['/repo']) });
    const repeated = snapshot(10);
    repeated.sync.completedDirectories = [];
    await applyIndex(repeated);
    const after = useGlobalSessionsStore.getState();
    expect(after.activeSessions).toBe(before);
    expect(after.loadingDirectories.size).toBe(0);
    expect(after.refreshingDirectories.size).toBe(0);
});

test('removed extension fields and nested array order are meaningful changes', async () => {
    await applyIndex(snapshot(10));
    const next = snapshot(11);
    delete next.directories[0].sessions[0].metadata;
    next.directories[0].sessions[1].metadata = { nested: { values: ['two', 1, null] } };
    await applyIndex(next);
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    expect(sessions.find((session) => session.id === 'session-0')?.metadata).toBeUndefined();
    expect(sessions.find((session) => session.id === 'session-1')?.metadata).toEqual({ nested: { values: ['two', 1, null] } });
});
