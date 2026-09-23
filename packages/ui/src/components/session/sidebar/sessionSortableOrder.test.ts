import { describe, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { useSessionFoldersStore, type SessionFolder } from '@/stores/useSessionFoldersStore';
import { buildEffectiveSessionOrderIndex, buildVisibleSortableSessionOrder, canReorderVisibleSessions, createSessionNodeComparator } from './sessionSortableOrder';

vi.mock('@/lib/runtime-fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-fetch')>(),
  runtimeFetch: vi.fn(async () => new Response('{}')),
}));

const folder = (id: string, parentId: string | null = null): SessionFolder => ({
  id,
  name: id,
  parentId,
  sessionIds: [],
  createdAt: 1,
});

const node = (id: string, updated = 0) => ({ session: { id, time: { created: updated, updated } } as Session });

describe('buildVisibleSortableSessionOrder', () => {
  test('follows folder hierarchy, scope-local folder rank, then the visible ungrouped rows', () => {
    const result = buildVisibleSortableSessionOrder({
      folders: [
        { folder: folder('first'), nodes: [node('first-b'), node('first-a')] },
        { folder: folder('nested', 'first'), nodes: [node('nested-a')] },
        { folder: folder('second'), nodes: [node('second-a')] },
      ],
      visibleUngroupedNodes: [node('ungrouped-a')],
      collapsedFolderIds: new Set(),
      hasSessionSearchQuery: false,
    });

    expect(result.sessionIds).toEqual(['nested-a', 'first-b', 'first-a', 'second-a', 'ungrouped-a']);
  });

  test('excludes collapsed folders and rejects cross-folder reorder while retaining ungrouped reorder', () => {
    const result = buildVisibleSortableSessionOrder({
      folders: [
        { folder: folder('first'), nodes: [node('first-a')] },
        { folder: folder('second'), nodes: [node('second-a')] },
      ],
      visibleUngroupedNodes: [node('ungrouped-a'), node('ungrouped-b')],
      collapsedFolderIds: new Set(['first']),
      hasSessionSearchQuery: false,
    });

    expect(result.sessionIds).toEqual(['second-a', 'ungrouped-a', 'ungrouped-b']);
    expect(canReorderVisibleSessions('second-a', 'ungrouped-a', result.folderIdBySessionId)).toBe(false);
    expect(canReorderVisibleSessions('ungrouped-a', 'ungrouped-b', result.folderIdBySessionId)).toBe(true);
  });

  test('keeps collapsed-folder search results visible', () => {
    const result = buildVisibleSortableSessionOrder({
      folders: [{ folder: folder('first'), nodes: [node('first-a')] }],
      visibleUngroupedNodes: [],
      collapsedFolderIds: new Set(['first']),
      hasSessionSearchQuery: true,
    });

    expect(result.sessionIds).toEqual(['first-a']);
  });
});

describe('session order activity snapshots', () => {
  test('retains natural activity order for legacy storage with no activity baseline', () => {
    const nodes = [node('a', 200), node('b', 100)];
    expect([...nodes].sort(createSessionNodeComparator(nodes, ['b', 'a'], undefined, new Set()))
      .map(({ session }) => session.id)).toEqual(['a', 'b']);
  });

  test('a second drag takes the current activity order as its new baseline', () => {
    const scope = '/workspace/second-drag';
    useSessionFoldersStore.setState({ sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
    const firstActivity = { a: 300, b: 200, c: 100 };
    useSessionFoldersStore.getState().reorderSessions(scope, ['a', 'b', 'c'], 'c', 'a', firstActivity);
    const advancedActivity = { ...firstActivity, b: 400 };
    const nodes = [node('a', 300), node('b', 400), node('c', 100)];
    const sort = () => {
      const state = useSessionFoldersStore.getState();
      return [...nodes].sort(createSessionNodeComparator(nodes, state.sessionOrderByScope[scope],
        state.sessionOrderActivityByScope[scope], new Set())).map(({ session }) => session.id);
    };
    expect(sort()).toEqual(['b', 'c', 'a']);
    useSessionFoldersStore.getState().reorderSessions(scope, sort(), 'a', 'b', advancedActivity);
    expect(sort()).toEqual(['a', 'b', 'c']);
    expect(sort()).toEqual(['a', 'b', 'c']);
    nodes[2] = node('c', 500);
    expect(sort()).toEqual(['c', 'a', 'b']);
  });

  test('keeps a dragged running session first when the group contains folded rows', () => {
    const scope = '/workspace/sort-regression';
    useSessionFoldersStore.setState({ sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
    const initial = [node('a', 400), node('b', 300), node('running', 200), node('folded', 100)];
    useSessionFoldersStore.getState().reorderSessions(scope, ['a', 'b', 'running'], 'running', 'a', {
      a: 400, b: 300, running: 200, folded: 100,
    });
    const state = useSessionFoldersStore.getState();
    const sort = (nodes: typeof initial) => [...nodes].sort(createSessionNodeComparator(
      nodes, state.sessionOrderByScope[scope], state.sessionOrderActivityByScope[scope], new Set(),
    )).map(({ session }) => session.id);
    expect(sort(initial)).toEqual(['running', 'a', 'b', 'folded']);
    expect(sort([node('a', 400), node('b', 300), node('running', 250), node('folded', 100)]))
      .toEqual(['running', 'a', 'b', 'folded']);
    expect(sort([node('a', 400), node('b', 500), node('running', 250), node('folded', 100)]))
      .toEqual(['b', 'running', 'a', 'folded']);
  });

  test('keeps matching manual order and promotes only sessions with newer activity on the current order', () => {
    const a = node('a', 200);
    const b = node('b', 100);
    const manualOrder = ['b', 'a'];
    const matchingActivity = { a: 200, b: 100 };

    const compareMatching = createSessionNodeComparator([a, b], manualOrder, matchingActivity, new Set());
    expect([a, b].sort(compareMatching).map((item) => item.session.id)).toEqual(['b', 'a']);

    const updatedA = node('a', 300);
    const compareUpdated = createSessionNodeComparator([updatedA, b], manualOrder, matchingActivity, new Set());
    expect([updatedA, b].sort(compareUpdated).map((item) => item.session.id)).toEqual(['a', 'b']);

    const c = node('c', 400);
    const compareAdded = createSessionNodeComparator([updatedA, b, c], manualOrder, matchingActivity, new Set());
    expect([updatedA, b, c].sort(compareAdded).map((item) => item.session.id)).toEqual(['c', 'a', 'b']);
  });

  test('keeps a dragged running session on top across later activity ticks for that same session', () => {
    const a = node('a', 300);
    const b = node('b', 200);
    const c = node('c', 100);
    // User dragged running `a` above the natural a,b,c order into a,c,b and saved that baseline.
    const manualOrder = ['a', 'c', 'b'];
    const baseline = { a: 300, b: 200, c: 100 };

    const sameTick = createSessionNodeComparator([a, b, c], manualOrder, baseline, new Set());
    expect([a, b, c].sort(sameTick).map((item) => item.session.id)).toEqual(['a', 'c', 'b']);

    const aStreaming = node('a', 350);
    const afterTick = createSessionNodeComparator([aStreaming, b, c], manualOrder, baseline, new Set());
    // Later activity on the already-top session must not restore natural b-before-c order.
    expect([aStreaming, b, c].sort(afterTick).map((item) => item.session.id)).toEqual(['a', 'c', 'b']);
  });

  test('promotes a later-active session on the current manual order without reshuffling the rest', () => {
    const b = node('b', 200);
    const c = node('c', 100);
    const manualOrder = ['c', 'a', 'b'];
    const baseline = { a: 300, b: 200, c: 100 };

    const aNewer = node('a', 400);
    const compare = createSessionNodeComparator([aNewer, b, c], manualOrder, baseline, new Set());
    expect([aNewer, b, c].sort(compare).map((item) => item.session.id)).toEqual(['a', 'c', 'b']);
    expect(buildEffectiveSessionOrderIndex([aNewer, b, c], manualOrder, baseline)).toEqual(
      new Map([['a', 0], ['c', 1], ['b', 2]]),
    );
  });

  test('ignores duplicate and stale activity refreshes so unrelated churn stays stable', () => {
    const a = node('a', 200);
    const b = node('b', 100);
    const manualOrder = ['b', 'a'];
    const baseline = { a: 200, b: 100 };

    const duplicate = createSessionNodeComparator([node('a', 200), node('b', 100)], manualOrder, baseline, new Set());
    expect([a, b].sort(duplicate).map((item) => item.session.id)).toEqual(['b', 'a']);

    const stale = createSessionNodeComparator([node('a', 150), node('b', 100)], manualOrder, baseline, new Set());
    expect([node('a', 150), b].sort(stale).map((item) => item.session.id)).toEqual(['b', 'a']);
  });
});
