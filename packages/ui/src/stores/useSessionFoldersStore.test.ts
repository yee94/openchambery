import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
