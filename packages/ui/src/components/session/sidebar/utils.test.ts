import { describe, expect, test } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';
import { compareSessionsByPinnedAndTime, isPathWithinProject } from './utils';

const session = (id: string, created: number, updated: number): Session => ({
  id,
  time: { created, updated },
} as Session);

describe('isPathWithinProject', () => {
  test('matches child directories for root projects', () => {
    expect(isPathWithinProject('/workspace/app', '/')).toBe(true);
  });

  test('matches exact project directories', () => {
    expect(isPathWithinProject('/workspace/app', '/workspace/app')).toBe(true);
  });

  test('does not match sibling directory prefixes', () => {
    expect(isPathWithinProject('/workspace/app2', '/workspace/app')).toBe(false);
  });

  test('returns false when directory is null', () => {
    expect(isPathWithinProject(null, '/workspace/app')).toBe(false);
  });

  test('returns false when projectPath is null', () => {
    expect(isPathWithinProject('/workspace/app', null)).toBe(false);
  });

  test('matches deep child directories', () => {
    expect(isPathWithinProject('/workspace/app/sub/dir', '/workspace/app')).toBe(true);
  });
});

describe('compareSessionsByPinnedAndTime', () => {
  test('keeps pinned-first then created-desc within pins, activity-desc otherwise', () => {
    const pinned = new Set(['old-pin', 'new-pin']);
    const sessions = [
      session('recent', 1, 300),
      session('old-pin', 10, 50),
      session('new-pin', 20, 40),
      session('older', 2, 200),
    ];
    const ordered = [...sessions]
      .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinned))
      .map((item) => item.id);
    expect(ordered).toEqual(['new-pin', 'old-pin', 'recent', 'older']);
  });
});
