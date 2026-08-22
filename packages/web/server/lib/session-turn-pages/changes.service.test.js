import { describe, expect, it, vi } from 'vitest';

import {
  createSessionChangesService,
  findChangeFileDiff,
  projectChangeFileEntry,
  projectChangeFileList,
} from './changes.service.js';

describe('projectChangeFileEntry', () => {
  it('keeps file/status/additions/deletions and drops patch bodies', () => {
    expect(projectChangeFileEntry({
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@',
      before: 'old',
      after: 'new',
      from: 'f',
      to: 't',
    })).toEqual({
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
    });
  });

  it('returns null when file is missing', () => {
    expect(projectChangeFileEntry({ additions: 1 })).toBeNull();
  });
});

describe('projectChangeFileList', () => {
  it('projects summary.diffs from a message envelope and never returns the message', () => {
    const list = projectChangeFileList({
      info: {
        id: 'msg_1',
        summary: {
          diffs: [
            { file: 'a.ts', status: 'added', additions: 2, deletions: 0, patch: 'big' },
            { file: 'b.ts', additions: 1, deletions: 1, before: 'x' },
            { additions: 9 },
          ],
        },
      },
      parts: [{ type: 'text', text: 'secret' }],
    });

    expect(list).toEqual({
      files: [
        { file: 'a.ts', status: 'added', additions: 2, deletions: 0 },
        { file: 'b.ts', additions: 1, deletions: 1 },
      ],
    });
    expect(list.info).toBeUndefined();
    expect(list.parts).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('patch');
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  it('returns empty files when summary.diffs is absent', () => {
    expect(projectChangeFileList({ info: { id: 'msg_1' }, parts: [] })).toEqual({ files: [] });
  });
});

describe('findChangeFileDiff', () => {
  it('matches exact file string only', () => {
    const diffs = [
      { file: 'src/a.ts', patch: 'a' },
      { file: 'src/b.ts', patch: 'b' },
    ];
    expect(findChangeFileDiff(diffs, 'src/b.ts')).toEqual({ file: 'src/b.ts', patch: 'b' });
    expect(findChangeFileDiff(diffs, 'src/missing.ts')).toBeNull();
    expect(findChangeFileDiff(diffs, 'src/A.ts')).toBeNull();
  });
});

describe('createSessionChangesService', () => {
  it('L2 path calls fetchMessage and returns projected files', async () => {
    const fetchMessage = vi.fn(async () => ({
      info: {
        summary: {
          diffs: [{
            file: 'hot.ts',
            status: 'modified',
            additions: 4,
            deletions: 2,
            patch: 'HUGE',
          }],
        },
      },
      parts: [],
    }));
    const fetchDiff = vi.fn();
    const service = createSessionChangesService({ fetchMessage, fetchDiff });

    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      directory: '/repo',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({
      files: [{
        file: 'hot.ts',
        status: 'modified',
        additions: 4,
        deletions: 2,
      }],
    });
    expect(fetchMessage).toHaveBeenCalledOnce();
    expect(fetchDiff).not.toHaveBeenCalled();
  });

  it('L3 path calls fetchDiff and returns the matched SnapshotFileDiff', async () => {
    const fetchMessage = vi.fn();
    const fetchDiff = vi.fn(async () => ([
      { file: 'a.ts', patch: 'a-patch', additions: 1, deletions: 0 },
      { file: 'b.ts', patch: 'b-patch', additions: 2, deletions: 1, status: 'modified' },
    ]));
    const service = createSessionChangesService({ fetchMessage, fetchDiff });

    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      file: 'b.ts',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({
      diff: {
        file: 'b.ts',
        patch: 'b-patch',
        additions: 2,
        deletions: 1,
        status: 'modified',
      },
    });
    expect(fetchDiff).toHaveBeenCalledOnce();
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it('returns change_not_found when file is absent from session.diff', async () => {
    const service = createSessionChangesService({
      fetchMessage: vi.fn(),
      fetchDiff: vi.fn(async () => [{ file: 'other.ts', patch: 'x' }]),
    });
    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      file: 'missing.ts',
    });
    expect(result).toEqual({ ok: false, error: 'change_not_found' });
  });

  it('maps abort errors to aborted', async () => {
    const service = createSessionChangesService({
      fetchMessage: vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }),
      fetchDiff: vi.fn(),
    });
    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
    });
    expect(result).toEqual({ ok: false, error: 'aborted' });
  });

  it('maps malformed/upstream failures to upstream', async () => {
    const service = createSessionChangesService({
      fetchMessage: vi.fn(),
      fetchDiff: vi.fn(async () => ({ not: 'array' })),
      logger: { warn: vi.fn() },
    });
    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      file: 'a.ts',
    });
    expect(result).toEqual({ ok: false, error: 'upstream' });
  });
});
