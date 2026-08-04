import { describe, expect, it, mock } from 'bun:test';

/**
 * Red-light contract for `session-turn-page-runtime.ts`.
 *
 * Parity with packages/web/server/lib/session-turn-pages/service.js:
 * predicate, turn selection, and loadPage aggregation (3 real user turns,
 * synthetic/subtask/compaction excluded, continuous cursor, explicit errors).
 *
 * Extension Host runtime implements the same contract as the web host service.
 */

const loadRuntime = () => import('./session-turn-page-runtime');

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

describe('isUserAuthoredTurnBoundary (VS Code parity with web)', () => {
  it('counts role user with non-synthetic parts as a turn boundary', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_1'))).toBe(true);
  });

  it('counts clientRole user when role is absent or non-user', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary({
      info: { id: 'msg_client', clientRole: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: 'typed' }],
    })).toBe(true);
    expect(isUserAuthoredTurnBoundary({
      info: { id: 'msg_client2', role: 'assistant', clientRole: 'user', time: { created: 2 } },
      parts: [{ type: 'text', text: 'typed' }],
    })).toBe(true);
  });

  it('counts user messages with empty parts as authored boundaries', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_empty', []))).toBe(true);
  });

  it('counts mixed real + synthetic parts as a boundary', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_mixed', mixedParts()))).toBe(true);
  });

  it('does not count assistant messages', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(assistant('msg_a'))).toBe(false);
  });

  it('does not count fully synthetic loop, plan, or shell user messages', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_loop', syntheticText('continue loop')))).toBe(false);
    expect(isUserAuthoredTurnBoundary(user('msg_plan', planParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(user('msg_shell', shellParts()))).toBe(false);
  });

  it('does not count subtask part messages as turn boundaries', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_subtask', subtaskParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(assistant('msg_subtask_a', subtaskParts()))).toBe(false);
  });

  it('does not count compaction part messages as turn boundaries', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(user('msg_compact', compactionParts()))).toBe(false);
    expect(isUserAuthoredTurnBoundary(assistant('msg_compact_a', compactionParts()))).toBe(false);
  });

  it('does not count hosted session dividers as turn boundaries', async () => {
    const { isUserAuthoredTurnBoundary } = await loadRuntime();
    expect(isUserAuthoredTurnBoundary(hostedDivider())).toBe(false);
  });
});

describe('selectTurnRecords (VS Code parity with web)', () => {
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

  it('returns records from the Nth-from-last authored user boundary, keeping intermediate rows', async () => {
    const { selectTurnRecords } = await loadRuntime();
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

  it('returns the full timeline when turnLimit exceeds authored boundaries', async () => {
    const { selectTurnRecords } = await loadRuntime();
    expect(selectTurnRecords(timeline, 10).map((entry) => entry.info.id))
      .toEqual(timeline.map((entry) => entry.info.id));
  });

  it('returns an empty list for empty input', async () => {
    const { selectTurnRecords } = await loadRuntime();
    expect(selectTurnRecords([], 3)).toEqual([]);
  });
});

describe('createSessionTurnPageService (VS Code parity with web)', () => {
  /**
   * OpenCode session.messages pages are chronological within the page (oldest → newest).
   * Pagination with `before` walks toward older history; each page is prepended
   * (deduped) into a global oldest → newest timeline.
   */
  const pageResult = (records, nextCursor = null) => ({
    records,
    nextCursor,
    complete: nextCursor == null,
  });

  it('keeps paging until three real user turns are collected (synthetic excluded)', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    // Pages are old→new within the page (not newest-first).
    // Chronological full: u1 a1 | u2 a2 | loop a_loop | u3 t3 a3
    const pages = new Map([
      [undefined, pageResult([tool('msg_t3'), assistant('msg_a3')], 'msg_t3')],
      ['msg_t3', pageResult([assistant('msg_a_loop'), user('msg_u3')], 'msg_a_loop')],
      ['msg_a_loop', pageResult([assistant('msg_a2'), user('msg_loop', syntheticText())], 'msg_a2')],
      ['msg_a2', pageResult([assistant('msg_a1'), user('msg_u2')], 'msg_a1')],
      ['msg_a1', pageResult([user('msg_u1')], null)],
    ]);
    const fetchPage = mock(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 3,
      directory: '/repo',
    });

    // Exhausted with exactly 3 authored turns and no overscan trim → complete.
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

  it('does not count subtask or compaction as turn boundaries while keeping them in the window', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    // Single exhausted page, chronological old→new
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
        user('msg_compact', compactionParts()),
        assistant('msg_a_compact'),
        user('msg_subtask', subtaskParts()),
        assistant('msg_a_sub'),
        user('msg_u3'),
        assistant('msg_a3'),
      ], null)],
    ]);
    const fetchPage = mock(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(true);
    expect(result.turnCount).toBe(3);
    const ids = result.records.map((entry) => entry.info.id);
    expect(ids).toContain('msg_subtask');
    expect(ids).toContain('msg_compact');
    expect(ids.filter((id) => id === 'msg_u1' || id === 'msg_u2' || id === 'msg_u3')).toHaveLength(3);
  });

  it('uses continuous opaque Host cursor pages without overlap or gap', async () => {
    const {
      createSessionTurnPageService,
      decodeHostCursor,
      encodeHostCursor,
    } = await loadRuntime();
    const all = [
      user('msg_u1'), assistant('msg_a1'),
      user('msg_u2'), assistant('msg_a2'),
      user('msg_u3'), assistant('msg_a3'),
      user('msg_u4'), assistant('msg_a4'),
    ];

    // Simulate OpenCode: page is chronological old→new; before walks older history.
    const fetchPage = mock(async ({ before, limit = 50 }) => {
      let end = all.length;
      if (before) {
        const index = all.findIndex((entry) => entry.info.id === before);
        end = index >= 0 ? index : 0;
      }
      const start = Math.max(0, end - limit);
      const slice = all.slice(start, end);
      const nextCursor = start > 0 ? slice[0]?.info.id ?? null : null;
      return pageResult(slice, nextCursor);
    });

    const service = createSessionTurnPageService({ fetchPage });
    const first = await service.loadPage({ sessionID: 'ses_1', turns: 2 });
    expect(first.ok).toBe(true);
    expect(first.turnCount).toBe(2);
    expect(typeof first.cursor).toBe('string');
    expect(first.cursor.startsWith('oc1.')).toBe(true);
    const firstDecoded = decodeHostCursor(first.cursor);
    expect(firstDecoded).toMatchObject({
      ok: true,
      payload: { before: null, boundaryID: 'msg_u3' },
    });
    // Round-trip shape matches encodeHostCursor
    expect(first.cursor).toBe(encodeHostCursor({ before: null, boundaryID: 'msg_u3' }));
    expect(first.records.map((entry) => entry.info.id)).toEqual([
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);

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

    const combined = [...second.records, ...first.records].map((entry) => entry.info.id);
    expect(combined).toEqual(all.map((entry) => entry.info.id));
  });

  it('returns complete=true and cursor=null when history exhausts below the turn budget', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = mock(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result).toMatchObject({
      ok: true,
      complete: true,
      cursor: null,
      turnCount: 2,
    });
  });

  it('returns complete=true when history exhausts with exactly N authored turns (no overscan trim)', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
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
    const fetchPage = mock(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result).toMatchObject({
      ok: true,
      complete: true,
      cursor: null,
      turnCount: 3,
    });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2', 'msg_u3', 'msg_a3',
    ]);
  });

  it('keeps complete=false with a cursor when exhausted history was overscan-trimmed', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    // 4 authored turns; turns=2 trims older overscan even though upstream exhausted.
    const all = [
      user('msg_u1'),
      assistant('msg_a1'),
      user('msg_u2'),
      assistant('msg_a2'),
      user('msg_u3'),
      assistant('msg_a3'),
      user('msg_u4'),
      assistant('msg_a4'),
    ];
    const fetchPage = mock(async ({ before, limit = 50 }) => {
      let end = all.length;
      if (before) {
        const index = all.findIndex((entry) => entry.info.id === before);
        end = index >= 0 ? index : 0;
      }
      const start = Math.max(0, end - limit);
      const slice = all.slice(start, end);
      const nextCursor = start > 0 ? slice[0]?.info.id ?? null : null;
      return pageResult(slice, nextCursor);
    });
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 2 });

    expect(result).toMatchObject({
      ok: true,
      complete: false,
      cursor: 'msg_u3',
      turnCount: 2,
    });
    expect(result.records.map((entry) => entry.info.id)).toEqual([
      'msg_u3', 'msg_a3', 'msg_u4', 'msg_a4',
    ]);

    // Client can still page older history with before=cursor
    const older = await service.loadPage({
      sessionID: 'ses_1',
      turns: 2,
      before: result.cursor,
    });
    expect(older.ok).toBe(true);
    expect(older.records.map((entry) => entry.info.id)).toEqual([
      'msg_u1', 'msg_a1', 'msg_u2', 'msg_a2',
    ]);
  });

  it('returns explicit upstream error when a record is missing info.id', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    const fetchPage = mock(async () => pageResult([
      user('msg_u1'),
      { info: { role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] },
    ], null));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/upstream/i);
    expect(result.records).toBeUndefined();
  });

  it('returns an explicit no-progress error for a repeated cursor without partial records', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    // old→new page that re-offers the same before cursor
    const fetchPage = mock(async () => pageResult([
      user('msg_u1'),
      assistant('msg_a1'),
    ], 'msg_u1'));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({
      sessionID: 'ses_1',
      turns: 3,
      before: 'msg_u1',
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/cursor|duplicate|no.?progress|stalled/i);
    expect(result.records).toBeUndefined();
  });

  it('returns an explicit no-progress error when an upstream page is empty but still carries a cursor', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    const fetchPage = mock(async () => pageResult([], 'msg_ghost'));
    const service = createSessionTurnPageService({ fetchPage });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/empty|no.?progress|cursor/i);
    expect(result.records).toBeUndefined();
  });

  it('returns an explicit too-large error when maxScanPages is exceeded without partial records', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    let page = 0;
    const fetchPage = mock(async () => {
      page += 1;
      return pageResult([assistant(`msg_a${page}`)], `cursor_${page}`);
    });
    const service = createSessionTurnPageService({
      fetchPage,
      maxScanPages: 3,
    });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/page|scan|limit|too.?large/i);
    expect(result.records).toBeUndefined();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('returns an explicit too-large error when maxScanMessages is exceeded without partial records', async () => {
    const { createSessionTurnPageService } = await loadRuntime();
    const fetchPage = mock(async () => pageResult(
      Array.from({ length: 20 }, (_, index) => assistant(`msg_a${index}`)),
      'msg_more',
    ));
    const service = createSessionTurnPageService({
      fetchPage,
      maxScanMessages: 15,
    });

    const result = await service.loadPage({ sessionID: 'ses_1', turns: 3 });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/message|scan|limit|too.?large/i);
    expect(result.records).toBeUndefined();
  });
});
