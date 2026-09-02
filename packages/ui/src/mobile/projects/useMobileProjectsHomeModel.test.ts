import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  listInProgressHomeSessions,
  listProjectAreaRootSessions,
} from './useMobileProjectsHomeModel';

const modelSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'useMobileProjectsHomeModel.ts'),
  'utf8',
);

const session = (
  id: string,
  options: {
    parentID?: string | null;
    created?: number;
    updated?: number;
    archived?: number;
  } = {},
): Session =>
  ({
    id,
    title: id,
    time: {
      created: options.created ?? 1,
      ...(options.updated != null ? { updated: options.updated } : {}),
      ...(options.archived != null ? { archived: options.archived } : {}),
    },
    ...(options.parentID ? { parentID: options.parentID } : {}),
  }) as Session;

describe('listProjectAreaRootSessions', () => {
  test('omits pinned roots from the project-area list', () => {
    const roots = listProjectAreaRootSessions(
      [session('pinned', { created: 20 }), session('visible', { created: 10 })],
      new Set(['pinned']),
    );

    expect(roots.map((entry) => entry.id)).toEqual(['visible']);
  });

  test('does not promote children of a pinned parent', () => {
    const roots = listProjectAreaRootSessions(
      [
        session('parent'),
        session('child', { parentID: 'parent' }),
      ],
      new Set(['parent']),
    );

    expect(roots).toEqual([]);
  });
});

describe('listInProgressHomeSessions', () => {
  test('keeps pinned sessions out and orders running plus unread by activity', () => {
    const active = listInProgressHomeSessions(
      [
        session('pinned-running', { updated: 50 }),
        session('running', { updated: 20 }),
        session('unread', { updated: 40 }),
        session('idle', { updated: 90 }),
        session('child-unread', { parentID: 'unread', updated: 80 }),
        session('archived-unread', { updated: 70, archived: 2 }),
      ],
      new Set(['pinned-running']),
      new Set(['pinned-running', 'running']),
      { unread: 1, 'child-unread': 1, 'archived-unread': 1 },
    );

    expect(active.map((entry) => entry.id)).toEqual(['unread', 'running']);
  });

  test('includes a running child even when the parent is idle', () => {
    const active = listInProgressHomeSessions(
      [
        session('parent', { updated: 10 }),
        session('child', { parentID: 'parent', updated: 11 }),
      ],
      new Set(),
      new Set(['child']),
      {},
    );

    expect(active.map((entry) => entry.id)).toEqual(['child']);
  });
});

describe('useMobileProjectsHomeModel shared pin contract', () => {
  test('reuses sidebar ownership, pinned derivation, and omit-pinned tree', () => {
    expect(modelSource).toContain('createSessionOwnershipIndex');
    expect(modelSource).toContain('derivePinnedSessions');
    expect(modelSource).toContain('listInProgressHomeSessions');
    expect(modelSource).toContain('omitPinnedSessions: true');
    expect(modelSource).toContain('listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds)');
  });
});
