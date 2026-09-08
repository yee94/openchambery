import { describe, expect, test } from 'vitest';

import {
  archiveLynxWorktreeLinkedSessions,
  collectLynxWorktreeLinkedSessions,
  lynxWorktreeHasBranch,
  probeLynxWorktreeDirty,
} from './worktreeDialogs';

describe('worktreeDialogs helpers', () => {
  test('collectLynxWorktreeLinkedSessions matches Cap directory filter + dedupe', () => {
    expect(collectLynxWorktreeLinkedSessions('/repo-wt', [
      { id: 'ses_1', directory: '/repo-wt' },
      { id: 'ses_1', directory: '/repo-wt/' },
      { id: 'ses_2', directory: '/repo' },
      { id: 'ses_3', directory: '/repo-wt' },
    ]).map((s) => s.id)).toEqual(['ses_1', 'ses_3']);
  });

  test('lynxWorktreeHasBranch gates local-branch toggle', () => {
    expect(lynxWorktreeHasBranch('feature')).toBe(true);
    expect(lynxWorktreeHasBranch('  ')).toBe(false);
    expect(lynxWorktreeHasBranch(null)).toBe(false);
  });

  test('archiveLynxWorktreeLinkedSessions archives via PATCH /session/:id', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await archiveLynxWorktreeLinkedSessions(runtimeFetch, [
      { id: 'ses_a', directory: '/repo-wt' },
      { id: 'ses_b', directory: '/repo-wt' },
    ]);
    expect(result).toEqual({ status: 'ok', archivedIds: ['ses_a', 'ses_b'] });
    expect(calls[0]).toContain('/session/ses_a');
    expect(calls[1]).toContain('/session/ses_b');
  });

  test('archiveLynxWorktreeLinkedSessions reports partial / no-runtime honestly', async () => {
    expect(await archiveLynxWorktreeLinkedSessions(null, [{ id: 'ses_1' }])).toEqual({
      status: 'no-runtime',
    });
    let n = 0;
    const runtimeFetch = async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const partial = await archiveLynxWorktreeLinkedSessions(runtimeFetch, [
      { id: 'ses_ok' },
      { id: 'ses_bad' },
    ]);
    expect(partial.status).toBe('partial');
    if (partial.status === 'partial') {
      expect(partial.archivedIds).toEqual(['ses_ok']);
      expect(partial.failedIds).toEqual(['ses_bad']);
    }
  });

  test('probeLynxWorktreeDirty uses Cap git status entries', async () => {
    const dirty = await probeLynxWorktreeDirty(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unstagedFiles: ['a.ts'] }),
    }), '/repo-wt');
    expect(dirty).toEqual({ status: 'ok', isDirty: true });

    const clean = await probeLynxWorktreeDirty(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stagedFiles: [], unstagedFiles: [], untrackedFiles: [] }),
    }), '/repo-wt');
    expect(clean).toEqual({ status: 'ok', isDirty: false });

    const failed = await probeLynxWorktreeDirty(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), '/repo-wt');
    expect(failed).toEqual({ status: 'unavailable' });
  });
});
