import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { buildSessionTree } from './sessionTree';

const session = (
  id: string,
  options: { parentID?: string | null; created?: number; archived?: number } = {},
): Session =>
  ({
    id,
    title: id,
    time: {
      created: options.created ?? 1,
      ...(options.archived ? { archived: options.archived } : {}),
    },
    ...(options.parentID ? { parentID: options.parentID } : {}),
  }) as Session;

describe('buildSessionTree', () => {
  test('omits pinned roots and keeps their children hidden from the project forest', () => {
    const parent = session('parent', { created: 20 });
    const child = session('child', { parentID: 'parent', created: 30 });
    const sibling = session('sibling', { created: 10 });

    const forest = buildSessionTree([parent, child, sibling], {
      pinnedSessionIds: new Set(['parent']),
      omitPinnedSessions: true,
    });

    expect(forest.map((node) => node.session.id)).toEqual(['sibling']);
    expect(forest[0]?.children).toEqual([]);
  });

  test('does not surface children of pinned parents as project roots', () => {
    const parent = session('parent');
    const child = session('child', { parentID: 'parent' });
    const grand = session('grand', { parentID: 'child' });

    const forest = buildSessionTree([parent, child, grand], {
      pinnedSessionIds: new Set(['parent']),
      omitPinnedSessions: true,
    });

    expect(forest).toEqual([]);
  });

  test('keeps unpinned parent/child trees intact', () => {
    const parent = session('parent');
    const child = session('child', { parentID: 'parent' });

    const forest = buildSessionTree([parent, child], {
      pinnedSessionIds: new Set(),
      omitPinnedSessions: true,
    });

    expect(forest).toHaveLength(1);
    expect(forest[0]?.session.id).toBe('parent');
    expect(forest[0]?.children.map((node) => node.session.id)).toEqual(['child']);
  });

  test('restores the parent/child tree after the parent is unpinned', () => {
    const parent = session('parent');
    const child = session('child', { parentID: 'parent' });
    const grand = session('grand', { parentID: 'child' });
    const sessions = [parent, child, grand];

    const whilePinned = buildSessionTree(sessions, {
      pinnedSessionIds: new Set(['parent']),
      omitPinnedSessions: true,
    });
    expect(whilePinned).toEqual([]);

    const afterUnpin = buildSessionTree(sessions, {
      pinnedSessionIds: new Set(),
      omitPinnedSessions: true,
    });
    expect(afterUnpin).toHaveLength(1);
    expect(afterUnpin[0]?.session.id).toBe('parent');
    expect(afterUnpin[0]?.children.map((node) => node.session.id)).toEqual(['child']);
    expect(afterUnpin[0]?.children[0]?.children.map((node) => node.session.id)).toEqual(['grand']);
  });

  test('never promotes orphan children to roots when the parent is missing', () => {
    const orphan = session('orphan-subagent', { parentID: 'missing-parent', created: 50 });
    const ordinary = session('ordinary', { created: 10 });

    const forest = buildSessionTree([orphan, ordinary], {
      pinnedSessionIds: new Set(),
      omitPinnedSessions: true,
    });

    expect(forest.map((node) => node.session.id)).toEqual(['ordinary']);
  });

  test('hides children when the parent is archived differently', () => {
    const parent = session('parent', { archived: 100, created: 20 });
    const child = session('child', { parentID: 'parent', created: 30 });
    const ordinary = session('ordinary', { created: 10 });

    const forest = buildSessionTree([parent, child, ordinary], {
      pinnedSessionIds: new Set(),
      omitPinnedSessions: true,
    });

    expect(forest.map((node) => node.session.id)).toEqual(['parent', 'ordinary']);
    expect(forest.find((node) => node.session.id === 'parent')?.children).toEqual([]);
  });
});
