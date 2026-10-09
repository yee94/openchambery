import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Event } from './types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionStatusStore } from './global-session-status';
import { handleEvent } from './sync-context';
import { ChildStoreManager } from './child-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

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
    useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], sessionsByDirectory: new Map() });
  });

  test.each([false, true])('promotes on transitions and preserves later drags on duplicate events (synced: %s)', (synced) => {
    const children = new ChildStoreManager();
    if (synced) children.ensureChild('/workspace/b', { bootstrap: false });
    const routing: Parameters<typeof handleEvent>[3] = {
      sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
    };
    handleEvent('/workspace/b', {
      type: 'session.created', properties: { info: { id: 'session-b', title: 'Ordinary chat', directory: '/workspace/b', time: { created: 1, updated: 1 } } },
    } as Event, children, routing);
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

  test.each([false, true])('background and unknown session transitions preserve project order (synced: %s)', (synced) => {
    const children = new ChildStoreManager();
    if (synced) children.ensureChild('/workspace/b', { bootstrap: false });
    const routing: Parameters<typeof handleEvent>[3] = {
      sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
    };
    useProjectsStore.getState().reorderProjectsById('c', 'a');
    const before = useProjectsStore.getState().projects;
    for (const [id, title, metadata] of [
      ['scheduled', '[Scheduled] Background run', undefined],
      ['assistant', '[Assistant] Background run', undefined],
      ['llm', '[openchamber-llm] generate', undefined],
      ['owned', 'Renamed background run', { openchamber: { scheduledTask: { taskID: 'task-1' } } }],
      ['unknown', undefined, undefined],
    ] as const) {
      if (title) handleEvent('/workspace/b', {
        type: 'session.created', properties: { info: { id, title, metadata, directory: '/workspace/b', time: { created: 1, updated: 1 } } },
      } as Event, children, routing);
      for (let repeat = 0; repeat < 10; repeat += 1) {
        for (const type of ['busy', 'retry', 'idle'] as const) {
          handleEvent('/workspace/b', {
            type: 'session.status', properties: { sessionID: id, status: { type } },
          } as Event, children, routing);
          expect(useProjectsStore.getState().projects).toBe(before);
          expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.status ?? 'idle').toBe(type);
        }
      }
    }
    expect(useProjectsStore.getState().manualProjectOrder).toEqual(['c', 'a', 'b']);
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

  test.each(['session.updated', 'openchamber:session-metadata', 'session.renamed'] as const)('stops project promotion after %s hides a known session', (type) => {
    const children = new ChildStoreManager();
    const routing: Parameters<typeof handleEvent>[3] = {
      sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
    };
    const info = { id: 'session-b', title: 'Task', directory: '/workspace/b', time: { created: 1, updated: 1 } };
    const metadata = { openchamber: { scheduledTask: { taskID: 'task-1' } } };
    handleEvent('/workspace/b', { type: 'session.created', properties: { info } } as Event, children, routing);
    handleEvent('/workspace/b', {
      type,
      properties: type === 'session.updated'
        ? { info: { ...info, metadata, time: { ...info.time, updated: 2 } } }
        : type === 'session.renamed'
          ? { sessionID: info.id, title: '[Scheduled] Task', eventCreated: 2 }
          : { sessionID: info.id, metadata },
    } as Event, children, routing);
    const before = useProjectsStore.getState().projects;
    handleEvent('/workspace/b', {
      type: 'session.status', properties: { sessionID: info.id, status: { type: 'busy' } },
    } as Event, children, routing);
    expect(useProjectsStore.getState().projects).toBe(before);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    children.disposeAll();
  });
});
