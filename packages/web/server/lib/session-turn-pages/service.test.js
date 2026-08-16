import { describe, expect, it, vi } from 'vitest';

import {
  createSessionTurnPageService,
  decodeHostCursor,
  encodeHostCursor,
  isUserAuthoredTurnBoundary,
  projectSlimParts,
  selectTurnRecords,
  SLIM_PARTS_PROJECTION,
} from './service.js';

const record = (id, role, parts = [{ type: 'text', text: 'hi' }], extra = {}) => ({
  info: { id, role, time: { created: Number(String(id).replace(/\D/g, '') || 0) }, ...extra },
  parts,
});

const user = (id, parts, extra) => record(id, 'user', parts, extra);
const assistant = (id, parts = [{ type: 'text', text: 'ok' }], extra) => record(id, 'assistant', parts, extra);
const tool = (id) => record(id, 'tool', [{ type: 'tool', name: 'bash' }]);

const syntheticText = (text = 'loop continue') => [{ type: 'text', text, synthetic: true }];
const mixedParts = () => [
  { type: 'text', text: '<system-reminder>', synthetic: true },
  { type: 'text', text: 'real prompt' },
];
const shellParts = () => [{
  type: 'text',
  text: 'The following tool was executed by the user\nbash',
  synthetic: true,
}];
const planParts = () => [{ type: 'text', text: 'plan injection', synthetic: true }];
const subtaskParts = () => [{ type: 'subtask', prompt: 'do it', description: 'task' }];
const compactionParts = () => [{ type: 'compaction', auto: false }];
const hostedDivider = (sessionID = 'ses_old') => ({
  info: {
    id: `oc_asst_session_divider:${sessionID}`,
    role: 'system',
    time: { created: 0 },
  },
  parts: [],
});

describe('isUserAuthoredTurnBoundary', () => {
  it('counts role user with non-synthetic parts as a turn boundary', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_1'))).toBe(true);
  });

  it('counts clientRole user when role is absent or non-user', () => {
    expect(isUserAuthoredTurnBoundary({
      info: { id: 'msg_client', clientRole: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: 'typed' }],
    })).toBe(true);
    expect(isUserAuthoredTurnBoundary({
      info: { id: 'msg_client2', role: 'assistant', clientRole: 'user', time: { created: 2 } },
      parts: [{ type: 'text', text: 'typed' }],
    })).toBe(true);
  });

  it('counts user messages with empty parts as authored boundaries', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_empty', []))).toBe(true);
  });

  it('counts mixed real + synthetic parts as a boundary', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_mixed', mixedParts()))).toBe(true);
  });

  it('does not count assistant messages', () => {
    expect(isUserAuthoredTurnBoundary(assistant('msg_a'))).toBe(false);
  });

  it('does not count fully synthetic loop, plan, or shell user messages', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_loop', syntheticText('continue loop')))).toBe(false);
    expect(isUserAuthoredTurnBoundary(user('msg_plan', planParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(user('msg_shell', shellParts()))).toBe(false);
  });

  it('does not count subtask part messages as turn boundaries', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_subtask', subtaskParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(assistant('msg_subtask_a', subtaskParts()))).toBe(false);
  });

  it('does not count compaction part messages as turn boundaries', () => {
    expect(isUserAuthoredTurnBoundary(user('msg_compact', compactionParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(assistant('msg_compact_a', compactionParts()))).toBe(false);
  });

  it('does not count hosted session dividers as turn boundaries', () => {
    expect(isUserAuthoredTurnBoundary(hostedDivider())).toBe(false);
  });
});

describe('selectTurnRecords', () => {
  const timeline = [
    user('msg_u1'),
    assistant('msg_a1'),
    user('msg_u2'),
    assistant('msg_a2'),
    user('msg_loop', syntheticText()),
    assistant('msg_a_loop'),
    user('msg_u3'),
    tool('msg_t3'),
    assistant('msg_a3'),
  ];

  it('returns records from the Nth-from-last authored user boundary, keeping intermediate rows', () => {
    const selected = selectTurnRecords(timeline, 2);
    expect(selected.map((entry) => entry.info.id)).toEqual([
      'msg_u2',
      'msg_a2',
      'msg_loop',
      'msg_a_loop',
      'msg_u3',
      'msg_t3',
      'msg_a3',
    ]);
  });

  it('returns the full timeline when turnLimit exceeds authored boundaries', () => {
    expect(selectTurnRecords(timeline, 10).map((entry) => entry.info.id))
      .toEqual(timeline.map((entry) => entry.info.id));
  });

  it('returns an empty list for empty input', () => {
    expect(selectTurnRecords([], 3)).toEqual([]);
  });
});

describe('host cursor codec', () => {
  it('round-trips before + boundaryID without message content', () => {
    const token = encodeHostCursor({ before: 'opaque_raw_xyz', boundaryID: 'msg_u3' });
    expect(token.startsWith('oc1.')).toBe(true);
    const decoded = decodeHostCursor(token);
    expect(decoded).toEqual({
      ok: true,
      value: { before: 'opaque_raw_xyz', boundaryID: 'msg_u3' },
    });
    expect(JSON.stringify(decoded.value)).not.toMatch(/text|parts|prompt|content/i);
  });

  it('encodes null before for the latest upstream page', () => {
    const token = encodeHostCursor({ before: null, boundaryID: 'msg_u2' });
    expect(decodeHostCursor(token)).toEqual({
      ok: true,
      value: { before: null, boundaryID: 'msg_u2' },
    });
  });

  it('rejects malformed host tokens', () => {
    expect(decodeHostCursor('oc1.not-valid-base64!!!').ok).toBe(false);
    expect(decodeHostCursor('oc1.' + Buffer.from('[]', 'utf8').toString('base64url')).ok).toBe(false);
    expect(decodeHostCursor('oc1.' + Buffer.from(JSON.stringify({ boundaryID: 'x' }), 'utf8').toString('base64url')).ok).toBe(false);
    expect(decodeHostCursor('msg_u1').ok).toBe(false);
  });
});

describe('projectSlimParts', () => {
  const toolPart = (id, output) => ({
    id,
    sessionID: 'ses_1',
    messageID: 'msg_a1',
    callID: `call_${id}`,
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      title: 'ran bash',
      time: { start: 1, end: 2 },
      output,
      metadata: { huge: 'x'.repeat(1000) },
      input: { command: 'ls' },
    },
  });

  it('drops tool output and metadata but keeps identity and status', () => {
    const [record] = projectSlimParts([
      { info: { id: 'msg_a1', role: 'assistant' }, parts: [toolPart('prt_1', 'x'.repeat(5000))] },
    ]);
    const part = record.parts[0];

    expect(part).toEqual({
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_a1',
      callID: 'call_prt_1',
      tool: 'bash',
      type: 'tool',
      state: {
        status: 'completed',
        title: 'ran bash',
        time: { start: 1, end: 2 },
        input: { command: 'ls' },
      },
      slim: true,
    });
    expect(JSON.stringify(part)).not.toContain('xxxx');
  });

  it('keeps read/grep locators and drops write content', () => {
    const [record] = projectSlimParts([
      {
        info: { id: 'msg_a1', role: 'assistant' },
        parts: [
          {
            id: 'prt_read',
            sessionID: 'ses_1',
            messageID: 'msg_a1',
            callID: 'call_read',
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              title: 'read file',
              input: { path: 'src/app.ts', offset: 1, content: 'SECRET BODY' },
              output: 'file body',
            },
          },
          {
            id: 'prt_grep',
            sessionID: 'ses_1',
            messageID: 'msg_a1',
            callID: 'call_grep',
            type: 'tool',
            tool: 'grep',
            state: {
              status: 'completed',
              input: { pattern: 'TODO', path: 'packages/ui', include: '*.ts' },
              output: 'many hits',
            },
          },
        ],
      },
    ]);

    expect(record.parts[0].state.input).toEqual({ path: 'src/app.ts', offset: 1 });
    expect(record.parts[1].state.input).toEqual({
      pattern: 'TODO',
      path: 'packages/ui',
      include: '*.ts',
    });
    expect(JSON.stringify(record.parts)).not.toContain('SECRET BODY');
    expect(JSON.stringify(record.parts)).not.toContain('file body');
  });

  it('keeps edit line counts and drops the patch body', () => {
    const [record] = projectSlimParts([
      {
        info: { id: 'msg_a1', role: 'assistant' },
        parts: [{
          id: 'prt_edit',
          sessionID: 'ses_1',
          messageID: 'msg_a1',
          callID: 'call_edit',
          type: 'tool',
          tool: 'edit',
          state: {
            status: 'completed',
            title: 'edit file',
            input: { path: 'src/app.ts', oldString: 'foo', newString: 'bar' },
            metadata: {
              patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n-foo\n+bar\n+baz\n',
            },
            output: 'applied',
          },
        }],
      },
    ]);

    expect(record.parts[0].state.input).toEqual({ path: 'src/app.ts' });
    expect(record.parts[0].state.metadata).toEqual({ additions: 2, deletions: 1 });
    expect(JSON.stringify(record.parts[0])).not.toContain('oldString');
    expect(JSON.stringify(record.parts[0])).not.toContain('+bar');
    expect(JSON.stringify(record.parts[0])).not.toContain('applied');
  });

  it('keeps per-file edit counts without file patches', () => {
    const [record] = projectSlimParts([
      {
        info: { id: 'msg_a1', role: 'assistant' },
        parts: [{
          id: 'prt_multi',
          sessionID: 'ses_1',
          messageID: 'msg_a1',
          callID: 'call_multi',
          type: 'tool',
          tool: 'multiedit',
          state: {
            status: 'completed',
            metadata: {
              files: [
                { relativePath: 'a.ts', additions: 3, deletions: 1, patch: 'SECRET PATCH A' },
                { filePath: 'b.ts', additions: 0, deletions: 2, patch: 'SECRET PATCH B' },
              ],
            },
          },
        }],
      },
    ]);

    expect(record.parts[0].state.metadata).toEqual({
      files: [
        { relativePath: 'a.ts', additions: 3, deletions: 1 },
        { filePath: 'b.ts', additions: 0, deletions: 2 },
      ],
      additions: 3,
      deletions: 3,
    });
    expect(JSON.stringify(record.parts[0])).not.toContain('SECRET PATCH');
  });

  it('keeps task agent name, description, and child session id', () => {
    const [record] = projectSlimParts([
      {
        info: { id: 'msg_a1', role: 'assistant' },
        parts: [{
          id: 'prt_task',
          sessionID: 'ses_1',
          messageID: 'msg_a1',
          callID: 'call_task',
          type: 'tool',
          tool: 'task',
          metadata: { sessionId: 'ses_child_part' },
          state: {
            status: 'completed',
            title: 'Goal 遇题自动暂停',
            input: {
              subagent_type: 'fixer',
              description: 'fix the load wall',
              prompt: 'A VERY LONG TASK PROMPT THAT MUST BE DROPPED',
            },
            metadata: { sessionId: 'ses_child', huge: 'x'.repeat(200) },
            output: '<task_metadata>{"sessionId":"ses_from_output"}</task_metadata>',
          },
        }],
      },
    ]);

    expect(record.parts[0].metadata).toEqual({ sessionId: 'ses_child_part' });
    expect(record.parts[0].state.input).toEqual({
      subagent_type: 'fixer',
      description: 'fix the load wall',
    });
    expect(record.parts[0].state.metadata).toEqual({ sessionId: 'ses_child' });
    expect(JSON.stringify(record.parts[0])).not.toContain('VERY LONG TASK PROMPT');
    expect(JSON.stringify(record.parts[0])).not.toContain('ses_from_output');
  });

  it('drops the reasoning body and keeps identity and timing', () => {
    const [record] = projectSlimParts([
      {
        info: { id: 'msg_a1', role: 'assistant' },
        parts: [{
          id: 'prt_r',
          sessionID: 'ses_1',
          messageID: 'msg_a1',
          type: 'reasoning',
          text: 'a long private trace',
          time: { start: 1 },
        }],
      },
    ]);

    expect(record.parts[0]).toEqual({
      id: 'prt_r',
      sessionID: 'ses_1',
      messageID: 'msg_a1',
      type: 'reasoning',
      time: { start: 1 },
      slim: true,
    });
  });

  it('leaves assistant text and user rows untouched', () => {
    const userRecord = user('msg_u1');
    const assistantText = assistant('msg_a1', [{ id: 'prt_t', type: 'text', text: 'the answer' }]);
    const records = [userRecord, assistantText];

    // Nothing to project → same array and same record references.
    expect(projectSlimParts(records)).toBe(records);
  });

  it('keeps the original reference for records it did not change', () => {
    const untouched = assistant('msg_a1', [{ id: 'prt_t', type: 'text', text: 'hi' }]);
    const projected = projectSlimParts([
      untouched,
      { info: { id: 'msg_a2', role: 'assistant' }, parts: [toolPart('prt_1', 'body')] },
    ]);

    expect(projected[0]).toBe(untouched);
    expect(projected[1].parts[0].slim).toBe(true);
  });

  it('exposes a stable projection marker', () => {
    expect(SLIM_PARTS_PROJECTION).toBe('slim-v1');
  });

  const pngDataUrl = (width, height) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.from([0x00, 0x00, 0x00, 0x0D]),
      Buffer.from('IHDR'),
      ihdr,
      Buffer.alloc(4),
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
  };

  const gifDataUrl = (width, height) => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(width, 6);
    gif.writeUInt16LE(height, 8);
    return `data:image/gif;base64,${gif.toString('base64')}`;
  };

  const jpegDataUrl = (width, height) => {
    const jpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08,
      (height >> 8) & 0xFF, height & 0xFF,
      (width >> 8) & 0xFF, width & 0xFF,
      0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9,
    ]);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  };

  const filePart = (overrides = {}) => ({
    id: 'prt_file',
    sessionID: 'ses_1',
    messageID: 'msg_u1',
    type: 'file',
    mime: 'image/png',
    filename: 'shot.png',
    url: pngDataUrl(12, 8),
    ...overrides,
  });

  it('strips data-URL bodies from user and assistant file parts and keeps metadata', () => {
    const url = pngDataUrl(12, 8);
    const userRecord = user('msg_u1', [filePart({ url, size: 99 })]);
    const assistantRecord = assistant('msg_a1', [filePart({
      id: 'prt_afile',
      messageID: 'msg_a1',
      url,
      metadata: { width: 64, height: 32 },
    })]);

    const [userProjected, assistantProjected] = projectSlimParts([userRecord, assistantRecord]);
    const userFile = userProjected.parts[0];
    const assistantFile = assistantProjected.parts[0];

    expect(userFile).toEqual({
      id: 'prt_file',
      sessionID: 'ses_1',
      messageID: 'msg_u1',
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      size: 99,
      byteSize: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length,
      width: 12,
      height: 8,
      slim: true,
    });
    expect(JSON.stringify(userFile)).not.toContain('base64');
    expect(JSON.stringify(userFile)).not.toContain(url);
    expect(userFile.url).toBeUndefined();

    expect(assistantFile.slim).toBe(true);
    expect(assistantFile.url).toBeUndefined();
    expect(assistantFile.width).toBe(64);
    expect(assistantFile.height).toBe(32);
    expect(assistantFile.byteSize).toBe(userFile.byteSize);
  });

  it('derives GIF/JPEG dimensions and omits unknown sizes', () => {
    const gif = filePart({
      id: 'prt_gif',
      mime: 'image/gif',
      filename: 'a.gif',
      url: gifDataUrl(7, 5),
    });
    const jpeg = filePart({
      id: 'prt_jpeg',
      mime: 'image/jpeg',
      filename: 'a.jpg',
      url: jpegDataUrl(9, 4),
    });
    const text = filePart({
      id: 'prt_txt',
      mime: 'text/plain',
      filename: 'note.txt',
      url: 'data:text/plain;base64,eA==',
    });
    const remote = filePart({
      id: 'prt_remote',
      mime: 'image/png',
      filename: 'remote.png',
      url: 'file:///tmp/remote.png',
    });

    const [record] = projectSlimParts([
      user('msg_u1', [gif, jpeg, text, remote]),
    ]);

    expect(record.parts[0]).toMatchObject({ width: 7, height: 5, slim: true });
    expect(record.parts[1]).toMatchObject({ width: 9, height: 4, slim: true });
    expect(record.parts[2].width).toBeUndefined();
    expect(record.parts[2].height).toBeUndefined();
    expect(record.parts[2].byteSize).toBe(1);
    expect(record.parts[3].byteSize).toBeUndefined();
    expect(record.parts[3].width).toBeUndefined();
    expect(JSON.stringify(record.parts)).not.toContain('file:///');
    expect(JSON.stringify(record.parts)).not.toContain('base64');
  });
});

describe('createSessionTurnPageService', () => {
  /**
   * Upstream pages are chronological old→new within each page (OpenCode
   * session.messages current order, including the latest slice).
   * Each page: { records, nextCursor, complete }.
   * nextCursor is an opaque raw SDK cursor — not a message id.
   */
  const pageResult = (records, nextCursor = null) => ({
    records,
    nextCursor,
    complete: nextCursor == null,
  });

  /**
   * Serve one chronological timeline as upstream pages of `width`.
   * Upstream hands back the latest slice first, then older slices by cursor,
   * each slice chronological old→new.
   */
  const pagedFetch = (timeline, width) => {
    const slices = [];
    for (let end = timeline.length; end > 0; end -= width) {
      slices.push(timeline.slice(Math.max(0, end - width), end));
    }
    const pages = new Map();
    slices.forEach((slice, index) => {
      const key = index === 0 ? undefined : `slice_${index}`;
      const hasOlder = index + 1 < slices.length;
      pages.set(key, pageResult(slice, hasOlder ? `slice_${index + 1}` : null));
    });
    return vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
  };

  it('returns the same page from narrow slices as from one wide slice', async () => {
    // 6 authored turns, each user + assistant, oldest→newest.
    const timeline = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      timeline.push(user(`msg_u${turn}`), assistant(`msg_a${turn}`));
    }

    const wide = createSessionTurnPageService({ fetchPage: pagedFetch(timeline, 100) });
    const narrowFetch = pagedFetch(timeline, 4);
    const narrow = createSessionTurnPageService({ fetchPage: narrowFetch });

    const args = { sessionID: 'ses_1', turns: 3, directory: '/repo' };
    const wideResult = await wide.loadPage(args);
    const narrowResult = await narrow.loadPage(args);

    expect(narrowResult.ok).toBe(true);
    expect(narrowResult.records.map((entry) => entry.info.id))
      .toEqual(wideResult.records.map((entry) => entry.info.id));
    expect(narrowResult.turnCount).toBe(wideResult.turnCount);
    expect(narrowResult.complete).toBe(wideResult.complete);
    // The narrow page genuinely exercised the extra-page path.
    expect(narrowFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps paging with before until three authored user boundaries are collected', async () => {
    // Chronological oldest→newest:
    // u1 a1 | u2 a2 | loop a_loop | u3 tool a3
    // Old→new pages of size 2 (latest slice first, then older pages prepended):
    const pages = new Map([
      [undefined, pageResult([tool('msg_t3'), assistant('msg_a3')], 'opaque_p1')],
      ['opaque_p1', pageResult([assistant('msg_a_loop'), user('msg_u3')], 'opaque_p2')],
      ['opaque_p2', pageResult([assistant('msg_a2'), user('msg_loop', syntheticText())], 'opaque_p3')],
      ['opaque_p3', pageResult([assistant('msg_a1'), user('msg_u2')], 'opaque_p4')],
      ['opaque_p4', pageResult([user('msg_u1')], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 3,
      directory: '/repo',
    });

    // Upstream exhausted with exactly 3 authored turns and no trimmed prefix.
    expect(result).toMatchObject({ ok: true, turnCount: 3, complete: true, cursor: null });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1',
      'msg_a1',
      'msg_u2',
      'msg_a2',
      'msg_loop',
      'msg_a_loop',
      'msg_u3',
      'msg_t3',
      'msg_a3',
    ]);
    expect(fetchPage.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/repo',
    }));
  });

  it('returns host cursor from opaque raw first page; second request fetchPage receives raw origin', async () => {
    // Full chronological: u1 a1 u2 a2 u3 a3 u4 a4
    // Opaque upstream pages (not message ids):
    //   before=undefined → u3 a3 u4 a4, next=opaque_older
    //   before=opaque_older → u1 a1 u2 a2, next=null
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u3'), assistant('msg_a3'),
        user('msg_u4'), assistant('msg_a4'),
      ], 'opaque_older')],
      ['opaque_older', pageResult([
        user('msg_u1'), assistant('msg_a1'),
        user('msg_u2'), assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const first = await service.loadPage({ sessionID: 'ses_1', turns: 2 });
    expect(first.ok).toBe(true);
    expect(first.turnCount).toBe(2);
    expect(first.complete).toBe(false);
    expect(typeof first.cursor).toBe('string');
    expect(first.cursor.startsWith('oc1.')).toBe(true);
    expect(first.records.map((entry) => entry.info.id)).toEqual([
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);

    const decoded = decodeHostCursor(first.cursor);
    expect(decoded.ok).toBe(true);
    expect(decoded.value.boundaryID).toBe('msg_u3');
    // Earliest selected user lived on the first upstream page (request before = null).
    expect(decoded.value.before).toBe(null);
    // Host token must not embed message bodies.
    expect(first.cursor).not.toMatch(/real prompt|hi|ok/);

    fetchPage.mockClear();
    const second = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: first.cursor,
    });
    expect(second.ok).toBe(true);
    expect(second.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);

    // First fetch of resume uses the raw origin stored in the host token (null → omitted/undefined).
    expect(fetchPage.mock.calls[0][0].before).toBeUndefined();
    // After boundary slice on the latest page, continues with that page's x-next-cursor.
    expect(fetchPage.mock.calls.some((call) => call[0].before === 'opaque_older')).toBe(true);

    const firstIds = new Set(first.records.map((entry) => entry.info.id));
    const secondIds = second.records.map((entry) => entry.info.id);
    expect(secondIds.some((id) => firstIds.has(id))).toBe(false);

    const combined = [...second.records, ...first.records].map((entry) => entry.info.id);
    expect(combined).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);
  });

  it('pages continuously with opaque origin when boundary sits mid-page (no overlap/gap)', async () => {
    // Latest page holds 3 turns; turns=2 selects from u3; host cursor origin is null + boundary u3.
    // Resume re-fetches latest page, keeps only before u3 (u2 a2), then older page.
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u2'), assistant('msg_a2'),
        user('msg_u3'), assistant('msg_a3'),
        user('msg_u4'), assistant('msg_a4'),
      ], 'opaque_mid')],
      ['opaque_mid', pageResult([
        user('msg_u1'), assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const first = await service.loadPage({ sessionID: 'ses_1', turns: 2 });
    expect(first.ok).toBe(true);
    expect(first.records.map((entry) => entry.info.id)).toEqual([
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);
    expect(first.complete).toBe(false);
    expect(decodeHostCursor(first.cursor)).toEqual({
      ok: true,
      value: { before: null, boundaryID: 'msg_u3' },
    });

    const second = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: first.cursor,
    });
    expect(second.ok).toBe(true);
    expect(second.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);

    const firstIds = new Set(first.records.map((entry) => entry.info.id));
    expect(second.records.some((entry) => firstIds.has(entry.info.id))).toBe(false);
    expect([...second.records, ...first.records].map((e) => e.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2', 'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);
  });

  it('passes through a raw SDK opaque cursor on the first request before emitting a host cursor', async () => {
    const pages = new Map([
      ['opaque_client_start', pageResult([
        user('msg_u2'), assistant('msg_a2'),
        user('msg_u3'), assistant('msg_a3'),
      ], 'opaque_more')],
      ['opaque_more', pageResult([
        user('msg_u1'), assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const first = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: 'opaque_client_start',
    });
    expect(first.ok).toBe(true);
    expect(fetchPage.mock.calls[0][0].before).toBe('opaque_client_start');
    expect(first.cursor.startsWith('oc1.')).toBe(true);
    expect(decodeHostCursor(first.cursor).value).toEqual({
      before: 'opaque_client_start',
      boundaryID: 'msg_u2',
    });

    fetchPage.mockClear();
    const second = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: first.cursor,
    });
    expect(second.ok).toBe(true);
    // Resume must re-fetch with the stored raw origin, not the host token string.
    expect(fetchPage.mock.calls[0][0].before).toBe('opaque_client_start');
    expect(second.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1',
    ]);
  });

  it('returns complete=true and cursor=null when history exhausts below the turn budget', async () => {
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result).toMatchObject({
      ok: true,
      complete: true,
      cursor: null,
      turnCount: 2,
    });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);
  });

  it('returns complete=true and cursor=null when upstream exhausts with exactly N turns and no trimmed prefix', async () => {
    // Exactly 2 authored turns, turns=2, single exhausted page — no older rows
    // were dropped by selectTurnRecords, so complete must be true.
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 2 });

    expect(result).toMatchObject({
      ok: true,
      complete: true,
      cursor: null,
      turnCount: 2,
    });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);
  });

  it('returns complete=false with host cursor when exhausted scan had more than N turns and older rows were trimmed', async () => {
    // One exhausted page holds 3 authored turns; turns=2 trims msg_u1/msg_a1.
    // Client must still be able to fetch the trimmed history via host cursor.
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
        user('msg_u3'),
        assistant('msg_a3'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 2 });

    expect(result.ok).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.turnCount).toBe(2);
    expect(result.cursor.startsWith('oc1.')).toBe(true);
    expect(decodeHostCursor(result.cursor)).toEqual({
      ok: true,
      value: { before: null, boundaryID: 'msg_u2' },
    });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u2', 'msg_a2', 'msg_u3', 'msg_a3',
    ]);

    // Overscan complete=false can continue via host cursor.
    const second = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: result.cursor,
    });
    expect(second.ok).toBe(true);
    expect(second.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1',
    ]);
    expect(second.complete).toBe(true);
    expect(second.cursor).toBe(null);
  });

  it('returns invalid_cursor for a malformed host token without calling fetchPage', async () => {
    const fetchPage = vi.fn(async () => pageResult([user('msg_u1')], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: 'oc1.%%%not-json%%%',
    });

    expect(result).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('returns invalid_cursor when host token boundary is missing from the origin page (stale)', async () => {
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'), assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const stale = encodeHostCursor({ before: null, boundaryID: 'msg_deleted' });
    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: stale,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('returns invalid_cursor when before exceeds the length limit', async () => {
    const fetchPage = vi.fn(async () => pageResult([user('msg_u1')], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: 'x'.repeat(8193),
    });

    expect(result).toEqual({ ok: false, error: 'invalid_cursor' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('returns an explicit error for a repeated cursor without partial records', async () => {
    const fetchPage = vi.fn(async () => pageResult([
      user('msg_u1'),
      assistant('msg_a1'),
    ], 'opaque_stall'));
    // First call with before=opaque_stall returns same next cursor (stall).
    fetchPage.mockImplementation(async ({ before }) => {
      if (before === 'opaque_stall') {
        return pageResult([user('msg_u1'), assistant('msg_a1')], 'opaque_stall');
      }
      return pageResult([user('msg_u1'), assistant('msg_a1')], 'opaque_stall');
    });
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 3,
      before: 'opaque_stall',
    });

    // When the only page re-offers the same cursor / fails to advance past before,
    // surface a structured error rather than a partial page.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cursor|duplicate/i);
    expect(result.records).toBeUndefined();
  });

  it('returns an explicit error when an upstream page is empty but still carries a cursor', async () => {
    const fetchPage = vi.fn(async () => pageResult([], 'msg_ghost'));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/i);
    expect(result.records).toBeUndefined();
  });

  it('returns an explicit error when maxScanPages is exceeded without partial records', async () => {
    let page = 0;
    const fetchPage = vi.fn(async () => {
      page += 1;
      // Never enough authored users — only assistants, always has more
      return pageResult([assistant(`msg_a${page}`)], `cursor_${page}`);
    });
    const service = createSessionTurnPageService({
      fetchPage,
      maxScanPages: 3,
    });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/page|scan|limit|too.?large/i);
    expect(result.records).toBeUndefined();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('returns an explicit error when maxScanMessages is exceeded without partial records', async () => {
    const fetchPage = vi.fn(async () => pageResult(
      Array.from({ length: 20 }, (_, index) => assistant(`msg_a${index}`)),
      'msg_more',
    ));
    const service = createSessionTurnPageService({
      fetchPage,
      maxScanMessages: 15,
    });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/message|scan|limit|too.?large/i);
    expect(result.records).toBeUndefined();
  });

  it('dedupes overlapping upstream records while preserving timeline order', async () => {
    // Overlapping pages share msg_u2 / msg_a1; pages stay old→new; older page prepends.
    const pages = new Map([
      [undefined, pageResult([
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
      ], 'opaque_dup')],
      ['opaque_dup', pageResult([
        user('msg_u1'),
        user('msg_u2'),
        assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 2 });

    expect(result.ok).toBe(true);
    const ids = result.records.map((entry) => entry.info.id);
    expect(ids).toEqual(['msg_u1', 'msg_a1', 'msg_u2', 'msg_a2']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns an explicit error when any upstream record lacks info.id without partial records', async () => {
    const fetchPage = vi.fn(async () => pageResult([
      user('msg_u1'),
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
      user('msg_u2'),
    ], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 2 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/upstream|id|malformed/i);
    expect(result.records).toBeUndefined();
  });

  it('forwards AbortSignal to fetchPage', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => pageResult([user('msg_u1')], null));
    const service = createSessionTurnPageService({ fetchPage });

    await service.loadPage({
      sessionID: 'ses_1',
      turns: 1,
      signal: controller.signal,
    });

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
