import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/v2-types';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { buildEffectiveSessionOrderIndex, buildVisibleSortableSessionOrder, canReorderVisibleSessions, createSessionNodeComparator } from './sessionSortableOrder';

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
  test('keeps matching manual order and restores natural order after activity or membership changes', () => {
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
    expect(buildEffectiveSessionOrderIndex([updatedA, b], manualOrder, matchingActivity)).toEqual(new Map());
  });
});
