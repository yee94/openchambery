import { describe, expect, it, vi } from 'vitest';

import {
  createSessionTurnPageService,
  decodeHostCursor,
  encodeHostCursor,
  isUserAuthoredTurnBoundary,
  selectTurnRecords,
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
