import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import type { Session, SessionInfo } from '@/lib/opencode/v2-types';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { INITIAL_STATE } from './types';

const fixture = vi.hoisted(() => ({
  store: null as ReturnType<typeof makeStore> | null,
  generation: 1,
}));
vi.mock('./sync-context', () => ({
  useDirectoryStore: () => fixture.store,
  useSyncDirectory: () => '/other',
  useChildStoreManager: () => ({ ensureChild: () => fixture.store, getChild: () => fixture.store }),
  dropCachedSessionMessageRecordsSnapshots: vi.fn(),
}));
vi.mock('@/lib/runtime-switch', async (original) => ({
  ...await original<typeof import('@/lib/runtime-switch')>(),
  getRuntimeGeneration: () => fixture.generation,
  getRuntimeKey: () => `runtime-${fixture.generation}`,
}));
import { useSync } from './use-sync';

const parent = { id: 'ses_parent', directory: '/repo', title: 'Parent', time: { created: 1, updated: 1 } } as Session;
function makeStore() {
  return createStore(() => ({ ...INITIAL_STATE, session: [parent] }));
}
const child = (index: number): SessionInfo => ({
  id: `ses_child_${index}`, parentID: parent.id, title: `Child ${index}`,
  location: { directory: '/repo' }, time: { created: 1, updated: 1 },
}) as SessionInfo;

let root: ReturnType<typeof createRoot>;
let sync: ReturnType<typeof useSync>;
const list = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.store = makeStore();
  fixture.generation += 1;
  const client = opencodeClient.getScopedSdkClient('/repo');
  vi.spyOn(opencodeClient, 'getScopedSdkClient').mockReturnValue({
    ...client, session: { ...client.session, list },
  });
  function Harness() { sync = useSync(); return null; }
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  list.mockReset();
});

test('explicit expansion loads all child pages and respects the row directory', async () => {
  expect(list).not.toHaveBeenCalled();
  list.mockResolvedValueOnce({ data: Array.from({ length: 50 }, (_, i) => child(i)), cursor: { next: 'page-2' } });
  list.mockResolvedValueOnce({ data: [child(50)], cursor: { next: 'end-anchor' } });
  await sync.loadChildren(parent.id, '/repo');
  expect(fixture.store!.getState().session).toHaveLength(52);
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ parentID: parent.id, directory: '/repo', limit: 50 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(list).toHaveBeenNthCalledWith(2, { cursor: 'page-2', limit: 50 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test('a later-page failure preserves the visible tree and can be retried', async () => {
  const existing = fixture.store!.getState().session;
  list.mockResolvedValueOnce({ data: Array.from({ length: 50 }, (_, i) => child(i)), cursor: { next: 'page-2' } });
  list.mockRejectedValueOnce(new Error('offline'));
  await expect(sync.loadChildren(parent.id, '/repo')).rejects.toThrow('offline');
  expect(fixture.store!.getState().session).toBe(existing);
  list.mockResolvedValueOnce({ data: [child(50)], cursor: {} });
  await sync.loadChildren(parent.id, '/repo');
  expect(fixture.store!.getState().session.map((session) => session.id)).toContain('ses_child_50');
});

test('a response from a replaced runtime cannot populate the tree', async () => {
  const existing = fixture.store!.getState().session;
  let resolve!: (value: { data: SessionInfo[]; cursor: { next?: string } }) => void;
  list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const pending = sync.loadChildren(parent.id, '/repo');
  fixture.generation += 1;
  resolve({ data: [child(0)], cursor: {} });
  await pending;
  expect(fixture.store!.getState().session).toBe(existing);
});

test('malformed and non-advancing pages fail instead of committing an incomplete tree', async () => {
  const existing = fixture.store!.getState().session;
  list.mockResolvedValueOnce({ cursor: {} });
  await expect(sync.loadChildren(parent.id, '/repo')).rejects.toThrow('returned no data');
  const page = { data: Array.from({ length: 50 }, (_, i) => child(i)), cursor: { next: 'same-cursor' } };
  list.mockResolvedValueOnce(page).mockResolvedValueOnce(page);
  await expect(sync.loadChildren(parent.id, '/repo')).rejects.toThrow('did not advance');
  expect(fixture.store!.getState().session).toBe(existing);
});
