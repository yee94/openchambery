import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

import { listProjectAreaRootSessions } from './useMobileProjectsHomeModel';

const modelSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'useMobileProjectsHomeModel.ts'),
  'utf8',
);

const session = (
  id: string,
  options: { parentID?: string | null; created?: number } = {},
): Session =>
  ({
    id,
    title: id,
    time: { created: options.created ?? 1 },
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

describe('useMobileProjectsHomeModel shared pin contract', () => {
  test('reuses sidebar ownership, pinned derivation, and omit-pinned tree', () => {
    expect(modelSource).toContain('createSessionOwnershipIndex');
    expect(modelSource).toContain('derivePinnedSessions');
    expect(modelSource).toContain('omitPinnedSessions: true');
    expect(modelSource).toContain('listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds)');
  });
});
