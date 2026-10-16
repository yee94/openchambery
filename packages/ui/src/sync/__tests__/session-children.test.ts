import { afterEach, describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types'
import { queryClient } from '@/lib/queryRuntime';

import { loadSessionChildrenOnDemand, mergeSessionChildren } from '../session-children';

afterEach(() => queryClient.clear());

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  title: id,
  version: '1',
  projectID: 'project_1',
  directory: '/repo',
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
});

describe('mergeSessionChildren', () => {
  test('adds only children belonging to the explicitly loaded parent', () => {
    const existing = [session('ses_parent')];
    const merged = mergeSessionChildren(existing, [
      session('ses_child', 'ses_parent'),
      session('ses_other_child', 'ses_other'),
    ], 'ses_parent');

    expect(merged.map((item) => item.id)).toEqual(['ses_child', 'ses_parent']);
  });

  test('preserves the session array when the on-demand response adds nothing', () => {
    const existing = [session('ses_child', 'ses_parent'), session('ses_parent')];
    expect(mergeSessionChildren(existing, [session('ses_child', 'ses_parent')], 'ses_parent')).toBe(existing);
  });

  test('deduplicates children repeated across pages', () => {
    expect(mergeSessionChildren([session('ses_parent')], [
      session('ses_child', 'ses_parent'), session('ses_child', 'ses_parent'),
    ], 'ses_parent').map((item) => item.id)).toEqual(['ses_child', 'ses_parent']);
  });
});

describe('loadSessionChildrenOnDemand', () => {
  test('coalesces concurrent clicks but refreshes on a later expansion', async () => {
    let calls = 0;
    let release: ((sessions: Session[]) => void) | undefined;
    const input = {
      transport: 'runtime-coalesce',
      generation: 1,
      directory: '/repo',
      sessionID: 'ses_parent',
      request: () => {
        calls += 1;
        return new Promise<Session[]>((resolve) => {
          release = resolve;
        });
      },
    };

    const first = loadSessionChildrenOnDemand(input);
    const second = loadSessionChildrenOnDemand(input);
    expect(calls).toBe(1);
    release?.([session('ses_child', 'ses_parent')]);
    expect(await first).toEqual(await second);
    const next = loadSessionChildrenOnDemand(input);
    expect(calls).toBe(2);
    release?.([session('ses_new_child', 'ses_parent')]);
    expect(await next).toEqual([session('ses_new_child', 'ses_parent')]);
  });

  test('does not cache a failed on-demand request', async () => {
    let calls = 0;
    const input = {
      transport: 'runtime-retry',
      generation: 1,
      directory: '/repo',
      sessionID: 'ses_parent',
      request: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return [];
      },
    };

    await expect(loadSessionChildrenOnDemand(input)).rejects.toThrow('offline');
    await loadSessionChildrenOnDemand(input);
    expect(calls).toBe(2);
  });
});
