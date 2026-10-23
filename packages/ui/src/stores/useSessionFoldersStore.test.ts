import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';
import { saveSessionOrder } from '@/queries/sessionOrderQueries';

vi.mock('@/queries/sessionOrderQueries', () => ({
  saveSessionOrder: vi.fn(async () => undefined),
  getSessionOrderSnapshot: () => undefined,
}));

const storage = new Map<string, string>();
let storageSetCount = 0;

const safeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageSetCount += 1;
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

mock.module('./utils/safeStorage', () => ({
  getDeferredSafeStorage: () => safeStorage,
  getSafeStorage: () => safeStorage,
  createDeferredSafeJSONStorage: () => undefined,
}));

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
  isDesktopShell: () => false,
  getDesktopHomeDirectory: async () => null,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
  setRuntimeInteractiveSessionRequestId: () => {},
}));

const { sessionOrderActivityMatches, useSessionFoldersStore } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  test('consecutive failed drags roll back to the last confirmed order, not an earlier failed drag', async () => {
    useSessionFoldersStore.setState({ sessionOrderByScope: { __pinned__: ['a', 'b', 'c'] }, sessionOrderActivityByScope: {} });
    vi.mocked(saveSessionOrder).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    const first = useSessionFoldersStore.getState().reorderSessions('__pinned__', ['a', 'b', 'c'], 'b', 'a', {});
    const second = useSessionFoldersStore.getState().reorderSessions('__pinned__', ['b', 'a', 'c'], 'c', 'b', {});
    await Promise.allSettled([first, second]);
    expect(useSessionFoldersStore.getState().sessionOrderByScope.__pinned__).toEqual(['a', 'b', 'c']);
  });
  test('failed server save rolls back only its scope and leaves unrelated orders intact', async () => {
    useSessionFoldersStore.setState({
      sessionOrderByScope: { __pinned__: ['a', 'b'], '/other': ['x'] },
      sessionOrderActivityByScope: { __pinned__: {} },
    });
    vi.mocked(saveSessionOrder).mockRejectedValueOnce(new Error('offline'));
    await expect(useSessionFoldersStore.getState().reorderSessions('__pinned__', ['a', 'b'], 'b', 'a', {}))
      .rejects.toThrow('offline');
    expect(useSessionFoldersStore.getState().sessionOrderByScope).toEqual({ __pinned__: ['a', 'b'], '/other': ['x'] });
    useSessionFoldersStore.getState().applySessionOrderSnapshot({
      revision: 2, sessionOrderByScope: { __pinned__: ['b', 'a'] }, sessionOrderActivityByScope: { __pinned__: {} },
    });
    expect(useSessionFoldersStore.getState().sessionOrderByScope.__pinned__).toEqual(['b', 'a']);
  });
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
      sessionOrderByScope: {},
      sessionOrderActivityByScope: {},
    });
  });

  test('repeated addSessionToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Work');
    store.addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('repeated addSessionsToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Batch');
    store.addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('cleanup trims stale session order ids and prunes activity without dropping survivor baselines', () => {
    useSessionFoldersStore.setState({
      sessionOrderByScope: { '/workspace/project': ['keep', 'stale'] },
      sessionOrderActivityByScope: { '/workspace/project': { keep: 2, stale: 1 } },
    });

    useSessionFoldersStore.getState().cleanupSessions('/workspace/project', new Set(['keep']));

    expect(useSessionFoldersStore.getState().sessionOrderByScope['/workspace/project']).toEqual(['keep']);
    expect(useSessionFoldersStore.getState().sessionOrderActivityByScope['/workspace/project']).toEqual({ keep: 2 });
    expect(sessionOrderActivityMatches({ keep: 2 }, useSessionFoldersStore.getState().sessionOrderActivityByScope['/workspace/project'])).toBe(true);
  });

  test('reorders folder rows by the scope-local visual ids', () => {
    useSessionFoldersStore.setState({ sessionOrderByScope: { '/workspace/project': ['first', 'second'] } });

    useSessionFoldersStore.getState().reorderSessions('/workspace/project', ['first', 'second'], 'second', 'first', { first: 2, second: 1 });

    expect(useSessionFoldersStore.getState().sessionOrderByScope['/workspace/project']).toEqual(['second', 'first']);
    expect(useSessionFoldersStore.getState().sessionOrderActivityByScope['/workspace/project']).toEqual({ first: 2, second: 1 });
  });

  test('preserves hidden session ranks outside the visible sortable slice', () => {
    useSessionFoldersStore.setState({
      sessionOrderByScope: { '/workspace/project': ['first', 'second', 'hidden'] },
      sessionOrderActivityByScope: { '/workspace/project': { first: 2, second: 1, hidden: 0 } },
    });

    useSessionFoldersStore.getState().reorderSessions('/workspace/project', ['first', 'second'], 'second', 'first', { first: 2, second: 1, hidden: 0 });

    expect(useSessionFoldersStore.getState().sessionOrderByScope['/workspace/project']).toEqual(['second', 'first', 'hidden']);
  });

  test('uses current visible order when the stored activity snapshot is missing or stale and keeps hidden ranks', () => {
    useSessionFoldersStore.setState({
      sessionOrderByScope: { '/workspace/project': ['first', 'second', 'hidden'] },
      sessionOrderActivityByScope: {},
    });

    useSessionFoldersStore.getState().reorderSessions('/workspace/project', ['second', 'first'], 'first', 'second', { first: 2, second: 1 });

    expect(useSessionFoldersStore.getState().sessionOrderByScope['/workspace/project']).toEqual(['first', 'second', 'hidden']);

    useSessionFoldersStore.setState({
      sessionOrderByScope: { '/workspace/project': ['first', 'second', 'hidden'] },
      sessionOrderActivityByScope: { '/workspace/project': { first: 1, second: 1, hidden: 0 } },
    });

    useSessionFoldersStore.getState().reorderSessions('/workspace/project', ['second', 'first'], 'first', 'second', { first: 2, second: 1 });

    expect(useSessionFoldersStore.getState().sessionOrderByScope['/workspace/project']).toEqual(['first', 'second', 'hidden']);
  });
});
