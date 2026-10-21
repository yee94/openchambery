import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

vi.mock('@/stores/useDirectoryStore', async () => {
    const { create } = await import('zustand');
    return { useDirectoryStore: create(() => ({ currentDirectory: null })) };
});
vi.hoisted(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    queryClient.clear();
    vi.unstubAllGlobals();
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
    useGlobalSessionsStore.setState({ activeSessions: sessions, hasHydratedSessionIndex: false });
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
