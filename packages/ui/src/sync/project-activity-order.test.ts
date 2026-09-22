import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionStatusStore } from './global-session-status';
import { handleEvent } from './sync-context';
import { ChildStoreManager } from './child-store';

vi.mock('@/lib/runtime-fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-fetch')>(),
  runtimeFetch: vi.fn(async () => new Response(JSON.stringify({ home: '/workspace' }))),
}));

describe('project drag and live activity ordering', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: ['a', 'b', 'c'].map((id) => ({ id, path: `/workspace/${id}` })),
      activeProjectId: 'a',
      manualProjectOrder: [],
    });
    useGlobalSessionStatusStore.setState({ statusById: new Map() });
  });

  test.each([false, true])('promotes on transitions and preserves later drags on duplicate events (synced: %s)', (synced) => {
    const children = new ChildStoreManager();
    if (synced) children.ensureChild('/workspace/b', { bootstrap: false });
    const routing: Parameters<typeof handleEvent>[3] = {
      sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
    };
    const event = (type: 'busy' | 'idle'): Event => ({
      id: `event-${type}`, type: 'session.status', properties: { sessionID: 'session-b', status: { type } },
    });
    useProjectsStore.getState().reorderProjectsById('c', 'a');
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['c', 'a', 'b']);
    handleEvent('/workspace/b', event('busy'), children, routing);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['b', 'c', 'a']);
    useProjectsStore.getState().reorderProjectsById('a', 'b');
    const afterDrag = useProjectsStore.getState().projects;
    handleEvent('/workspace/b', event('busy'), children, routing);
    expect(useProjectsStore.getState().projects).toBe(afterDrag);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['a', 'b', 'c']);
    handleEvent('/workspace/b', event('idle'), children, routing);
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['b', 'a', 'c']);
    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(['b', 'a', 'c']);
    expect(useProjectsStore.getState().activeProjectId).toBe('a');
    children.disposeAll();
  });

  test('uses bootstrapped child status as the baseline for the first live event', () => {
    const children = new ChildStoreManager();
    const child = children.ensureChild('/workspace/b', { bootstrap: false });
    child.setState({ session_status: { 'session-b': { type: 'busy' } } });
    const routing: Parameters<typeof handleEvent>[3] = {
      sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
    };
    useProjectsStore.getState().reorderProjectsById('c', 'a');
    const afterDrag = useProjectsStore.getState().projects;
    handleEvent('/workspace/b', {
      id: 'duplicate', type: 'session.status', properties: { sessionID: 'session-b', status: { type: 'busy' } },
    }, children, routing);
    expect(useProjectsStore.getState().projects).toBe(afterDrag);
    children.disposeAll();
  });
});
