import { describe, expect, it, vi } from 'vitest';

const loadRuntime = () => import('./session-turn-changes-runtime.ts');

describe('session-turn-changes-runtime', () => {
  it('projects L2 file list without patch bodies', async () => {
    const { projectChangeFileList } = await loadRuntime();
    const result = projectChangeFileList({
      info: {
        id: 'msg_1',
        summary: {
          diffs: [{
            file: 'src/a.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            patch: '@@ huge @@',
            before: 'old',
            after: 'new',
          }],
        },
      },
      parts: [{ type: 'text', text: 'hello' }],
    });

    expect(result).toEqual({
      files: [{
        file: 'src/a.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
      }],
    });
    expect(JSON.stringify(result)).not.toContain('patch');
    expect(JSON.stringify(result)).not.toContain('hello');
  });

  it('finds exact L3 file match', async () => {
    const { findChangeFileDiff } = await loadRuntime();
    const match = findChangeFileDiff([
      { file: 'a.ts', patch: 'a' },
      { file: 'b.ts', patch: 'b' },
    ], 'b.ts');
    expect(match).toEqual({ file: 'b.ts', patch: 'b' });
    expect(findChangeFileDiff([{ file: 'a.ts' }], 'missing.ts')).toBeNull();
  });

  it('loadChanges L2 uses fetchMessage and L3 uses fetchDiff', async () => {
    const { createSessionChangesService } = await loadRuntime();
    const fetchMessage = vi.fn(async () => ({
      info: { summary: { diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }] } },
    }));
    const fetchDiff = vi.fn(async () => ([
      { file: 'a.ts', patch: '@@' },
    ]));
    const service = createSessionChangesService({ fetchMessage, fetchDiff });

    const list = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      directory: '/repo',
    });
    expect(list.ok).toBe(true);
    expect(list.body).toEqual({
      files: [{ file: 'a.ts', additions: 1, deletions: 0 }],
    });
    expect(fetchDiff).not.toHaveBeenCalled();

    const file = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      file: 'a.ts',
    });
    expect(file.ok).toBe(true);
    expect(file.body).toEqual({ diff: { file: 'a.ts', patch: '@@' } });
    expect(fetchMessage).toHaveBeenCalledTimes(1);
  });

  it('returns change_not_found when L3 file is missing', async () => {
    const { createSessionChangesService } = await loadRuntime();
    const service = createSessionChangesService({
      fetchMessage: vi.fn(),
      fetchDiff: vi.fn(async () => ([{ file: 'other.ts', patch: 'x' }])),
    });
    const result = await service.loadChanges({
      sessionID: 'ses_1',
      messageID: 'msg_1',
      file: 'missing.ts',
    });
    expect(result).toEqual({ ok: false, error: 'change_not_found' });
  });
});
