import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

import {
  formatHomeSessionSubtitle,
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
  test('keeps pinned roots in the project-area list', () => {
    const roots = listProjectAreaRootSessions(
      [session('pinned', { created: 20 }), session('visible', { created: 10 })],
      new Set(['pinned']),
    );

    expect(roots.map((entry) => entry.id)).toEqual(['pinned', 'visible']);
  });

  test('does not promote children of a pinned parent', () => {
    const roots = listProjectAreaRootSessions(
      [
        session('parent'),
        session('child', { parentID: 'parent' }),
      ],
      new Set(['parent']),
    );

    expect(roots.map((entry) => entry.id)).toEqual(['parent']);
  });
});

describe('useMobileProjectsHomeModel shared pin contract', () => {
  test('reuses sidebar ownership and keeps pinned sessions in project trees', () => {
    expect(modelSource).toContain('createSessionOwnershipIndex');
    expect(modelSource).toContain('derivePinnedSessions');
    expect(modelSource).toContain('listInProgressHomeSessions');
    expect(modelSource).not.toContain('omitPinnedSessions: true');
    expect(modelSource).toContain('listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds)');
    expect(modelSource).toContain('catalogSessions: catalogRoots.map(toNode)');
    expect(modelSource).toContain('omitPinnedSessions: false');
  });

  test('uses a shared project · branch subtitle for pinned and in-progress rows', () => {
    expect(modelSource).toContain('formatHomeSessionSubtitle(project.label, worktree?.branch)');
    expect(modelSource).not.toContain('subtitle: pinned ? project.label : undefined');
    expect(modelSource).toContain('formatSessionChangeCounts(readSessionChangeSummary(session))');
  });
});

describe('formatHomeSessionSubtitle', () => {
  test('joins project and branch, and falls back to the project label', () => {
    expect(formatHomeSessionSubtitle('yuri', 'feat/home')).toBe('yuri · feat/home');
    expect(formatHomeSessionSubtitle('yuri', '  ')).toBe('yuri');
    expect(formatHomeSessionSubtitle('yuri', null)).toBe('yuri');
  });
});
