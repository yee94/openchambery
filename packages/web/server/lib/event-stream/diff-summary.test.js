import { describe, expect, it } from 'vitest';

import {
  projectMessageSummaryDiffCounts,
  projectMessageSummaryDiffSlim,
  summarizeFileDiff,
  summarizeFileDiffs,
  summarizeOutboundEventPayload,
} from './diff-summary.js';

describe('summarizeFileDiff', () => {
  it('keeps display scalars and drops large body fields', () => {
    const full = {
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -1,3 +1,5 @@\n+line',
      before: 'old content',
      after: 'new content',
      from: 'from-blob',
      to: 'to-blob',
    };

    expect(summarizeFileDiff(full)).toEqual({
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
    });
  });

  it('preserves object identity when already a summary', () => {
    const summary = {
      file: 'src/a.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
    };
    expect(summarizeFileDiff(summary)).toBe(summary);
  });
});

describe('summarizeFileDiffs', () => {
  it('preserves array identity when nothing changes', () => {
    const already = [
      { file: 'a.ts', additions: 1, deletions: 0 },
    ];
    expect(summarizeFileDiffs(already)).toBe(already);
  });
});

describe('projectMessageSummaryDiffSlim', () => {
  it('keeps slim summary.diffs and sets diffCount/hasDiffs', () => {
    const owner = {
      id: 'msg_1',
      summary: {
        title: 'turn',
        diffs: [
          { file: 'a.ts', additions: 1, deletions: 0, patch: '@@' },
          { file: 'b.ts', additions: 2, deletions: 1, before: 'x', after: 'y' },
        ],
      },
    };

    const next = projectMessageSummaryDiffSlim(owner);
    expect(next).not.toBe(owner);
    expect(next.summary).toEqual({
      title: 'turn',
      diffs: [
        { file: 'a.ts', additions: 1, deletions: 0 },
        { file: 'b.ts', additions: 2, deletions: 1 },
      ],
      diffCount: 2,
      hasDiffs: true,
    });
    expect(JSON.stringify(next)).not.toContain('patch');
    expect(JSON.stringify(next)).not.toContain('"before"');
    expect(JSON.stringify(next)).not.toContain('"after"');
  });

  it('projects empty arrays to slim list + diffCount 0 / hasDiffs false', () => {
    const owner = {
      summary: { diffs: [] },
    };
    expect(projectMessageSummaryDiffSlim(owner).summary).toEqual({
      diffs: [],
      diffCount: 0,
      hasDiffs: false,
    });
  });

  it('keeps identity when summary has no diffs key', () => {
    const owner = { summary: { title: 'x', diffCount: 3, hasDiffs: true } };
    expect(projectMessageSummaryDiffSlim(owner)).toBe(owner);
  });

  it('keeps identity when diffs already slim and markers match', () => {
    const owner = {
      summary: {
        diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
        diffCount: 1,
        hasDiffs: true,
      },
    };
    expect(projectMessageSummaryDiffSlim(owner)).toBe(owner);
  });

  it('exports projectMessageSummaryDiffCounts as a compatible alias', () => {
    expect(projectMessageSummaryDiffCounts).toBe(projectMessageSummaryDiffSlim);
  });
});

describe('summarizeOutboundEventPayload', () => {
  it('summarizes session.diff properties.diff', () => {
    const payload = {
      type: 'session.diff',
      properties: {
        sessionID: 'ses_1',
        diff: [{
          file: 'hot.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: 'big',
        }],
      },
    };

    const next = summarizeOutboundEventPayload(payload);
    expect(next).not.toBe(payload);
    expect(next.properties.diff).toEqual([{
      file: 'hot.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
    }]);
  });

  it('summarizes session.diff data.diff (current envelope)', () => {
    const payload = {
      type: 'session.diff',
      data: {
        sessionID: 'ses_1',
        diff: [{
          file: 'hot.ts',
          additions: 2,
          deletions: 1,
          before: 'x',
          after: 'y',
        }],
      },
    };

    const next = summarizeOutboundEventPayload(payload);
    expect(next.data.diff).toEqual([{
      file: 'hot.ts',
      additions: 2,
      deletions: 1,
    }]);
  });

  it('projects message.updated info.summary.diffs to L1 slim list + markers', () => {
    const payload = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          summary: {
            diffs: [{
              file: 'a.ts',
              additions: 1,
              deletions: 0,
              patch: '@@',
              from: 'blob-a',
              to: 'blob-b',
            }],
          },
        },
      },
    };

    const next = summarizeOutboundEventPayload(payload);
    expect(next.properties.info.summary).toEqual({
      diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
      diffCount: 1,
      hasDiffs: true,
    });
    expect(JSON.stringify(next)).not.toContain('patch');
    expect(JSON.stringify(next)).not.toContain('blob-a');
  });

  it('returns identity for session.status', () => {
    const payload = {
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' } },
    };
    expect(summarizeOutboundEventPayload(payload)).toBe(payload);
  });

  it('returns identity when diffs already summarized', () => {
    const payload = {
      type: 'session.diff',
      properties: {
        sessionID: 'ses_1',
        diff: [{ file: 'a.ts', additions: 1, deletions: 0 }],
      },
    };
    expect(summarizeOutboundEventPayload(payload)).toBe(payload);
  });
});
