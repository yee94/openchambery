import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createSessionReconcileService,
  decodeReconcileContinuation,
  encodeReconcileContinuation,
} from './reconcile.service.js';

const record = (id, role, parts = [{ type: 'text', text: 'hi' }], extra = {}) => ({
  info: { id, role, time: { created: Number(String(id).replace(/\D/g, '') || 0) }, ...extra },
  parts,
});

const user = (id, parts, extra) => record(id, 'user', parts, extra);
const assistant = (id, parts = [{ type: 'text', text: 'ok' }], extra) => record(id, 'assistant', parts, extra);

const pageResult = (records, nextCursor = null) => ({
  records,
  nextCursor,
  complete: nextCursor == null,
});

const ids = (records) => records.map((entry) => entry.info.id);

const RUNTIME = 'test-runtime-key';
const TEST_SECRET = Buffer.from('test-reconcile-secret-32-bytes!!', 'utf8');
const OTHER_SECRET = Buffer.from('other-reconcile-secret-32bytes!!', 'utf8');
const FIXED_NOW = 1_700_000_000_000; // ms
const clockAt = (ms) => () => ms;

const bindingPayload = (overrides = {}) => ({
  runtime: RUNTIME,
  directory: '/repo',
  sessionID: 'ses_1',
  anchor: 'msg_u2',
  capturedHead: 'msg_a5',
  scanBefore: 'opaque_older',
  returnedThroughID: 'msg_u4',
  scannedRecords: 12,
  scannedBytes: 4096,
  pagesEmitted: 1,
  ...overrides,
});

const codecOptions = (overrides = {}) => ({
  secret: TEST_SECRET,
  clock: clockAt(FIXED_NOW),
  ttlMs: 15 * 60 * 1000,
  ...overrides,
});

const serviceOptions = (fetchPage, overrides = {}) => ({
  fetchPage,
  runtimeKey: RUNTIME,
  continuationSecret: TEST_SECRET,
  clock: clockAt(FIXED_NOW),
  continuationTtlMs: 15 * 60 * 1000,
  ...overrides,
});

describe('reconcile continuation codec (ocr2 signed)', () => {
  it('round-trips binding fields with iat/exp and without message content', () => {
    const token = encodeReconcileContinuation(bindingPayload(), codecOptions());
    expect(token.startsWith('ocr2.')).toBe(true);
    expect(token.split('.').length).toBe(3);
    const decoded = decodeReconcileContinuation(token, codecOptions());
    expect(decoded.ok).toBe(true);
    expect(decoded.value).toMatchObject({
      runtime: RUNTIME,
      directory: '/repo',
      sessionID: 'ses_1',
      anchor: 'msg_u2',
      capturedHead: 'msg_a5',
      scanBefore: 'opaque_older',
      returnedThroughID: 'msg_u4',
      scannedRecords: 12,
      scannedBytes: 4096,
      pagesEmitted: 1,
      iat: Math.floor(FIXED_NOW / 1000),
      exp: Math.floor(FIXED_NOW / 1000) + 15 * 60,
    });
    expect(token).not.toMatch(/hi|ok|parts|prompt|content|Bearer/i);
  });

  it('rejects legacy unsigned ocr1 tokens', () => {
    const legacyBody = Buffer.from(JSON.stringify({
      v: 1,
      runtime: RUNTIME,
      directory: '/repo',
      sessionID: 'ses_1',
      anchor: 'msg_u2',
      capturedHead: 'msg_a5',
      scanBefore: null,
      returnedThroughID: 'msg_u4',
      scannedRecords: 1,
      scannedBytes: 10,
      pagesEmitted: 1,
    }), 'utf8').toString('base64url');
    expect(decodeReconcileContinuation(`ocr1.${legacyBody}`, codecOptions()).ok).toBe(false);
  });

  it('rejects tampered payload while keeping a valid-looking mac structure', () => {
    const token = encodeReconcileContinuation(bindingPayload(), codecOptions());
    const [, payloadPart, macPart] = token.split('.');
    const raw = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    raw.pagesEmitted = 99;
    const tamperedPayload = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
    const tampered = `ocr2.${tamperedPayload}.${macPart}`;
    expect(decodeReconcileContinuation(tampered, codecOptions()).ok).toBe(false);
  });

  it('rejects wrong secret (simulates process restart / different host key)', () => {
    const token = encodeReconcileContinuation(bindingPayload(), codecOptions({ secret: TEST_SECRET }));
    expect(decodeReconcileContinuation(token, codecOptions({ secret: OTHER_SECRET })).ok).toBe(false);
    // Same secret still works.
    expect(decodeReconcileContinuation(token, codecOptions({ secret: TEST_SECRET })).ok).toBe(true);
  });

  it('rejects expired tokens and accepts tokens within TTL', () => {
    const token = encodeReconcileContinuation(
      bindingPayload(),
      codecOptions({ clock: clockAt(FIXED_NOW), ttlMs: 60_000 }),
    );
    // Still valid just before exp.
    expect(decodeReconcileContinuation(
      token,
      codecOptions({ clock: clockAt(FIXED_NOW + 59_000) }),
    ).ok).toBe(true);
    // Expired after TTL.
    expect(decodeReconcileContinuation(
      token,
      codecOptions({ clock: clockAt(FIXED_NOW + 61_000) }),
    ).ok).toBe(false);
  });

  it('rejects malformed, truncated, or oversize continuation tokens', () => {
    expect(decodeReconcileContinuation('ocr2.not-json.mac', codecOptions()).ok).toBe(false);
    expect(decodeReconcileContinuation('ocr2.onlypayload', codecOptions()).ok).toBe(false);
    expect(decodeReconcileContinuation('oc1.something', codecOptions()).ok).toBe(false);
    expect(decodeReconcileContinuation('x'.repeat(9000), codecOptions()).ok).toBe(false);

    // Valid structure but bad mac bytes.
    const payload = Buffer.from(JSON.stringify({
      v: 2,
      runtime: RUNTIME,
      directory: null,
      sessionID: 'ses_1',
      anchor: 'a',
      capturedHead: 'h',
      scanBefore: null,
      returnedThroughID: null,
      scannedRecords: 0,
      scannedBytes: 0,
      pagesEmitted: 0,
      iat: 1,
      exp: 9999999999,
    }), 'utf8').toString('base64url');
    const badMac = createHmac('sha256', OTHER_SECRET).update(payload).digest('base64url');
    expect(decodeReconcileContinuation(`ocr2.${payload}.${badMac}`, codecOptions()).ok).toBe(false);
  });
});

describe('createSessionReconcileService', () => {
  it('finds anchor on a single page and returns gap records including overlap turn', async () => {
    // Chronological: u1 a1 | u2 a2_partial | u3 a3
    // Anchor = u2 (stable turn boundary). Gap = u2..a3 (overlap turn + newer).
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        assistant('msg_a1'),
        user('msg_u2'),
        assistant('msg_a2', [{ type: 'text', text: 'streaming...' }]),
        user('msg_u3'),
        assistant('msg_a3'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 50,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 10,
      totalByteLimit: 5 * 1024 * 1024,
    }));

    const result = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      anchor: 'msg_u2',
    });

    expect(result.ok).toBe(true);
    expect(result.anchorFound).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.resetRequired).toBe(false);
    expect(result.capturedHeadMessageID).toBe('msg_a3');
    expect(result.latestHeadMessageID).toBe('msg_a3');
    expect(result.continuation).toBe(null);
    expect(ids(result.records)).toEqual([
      'msg_u2',
      'msg_a2',
      'msg_u3',
      'msg_a3',
    ]);
    // Overlap turn includes the in-progress assistant after the anchor user.
    expect(result.records[1].parts[0].text).toBe('streaming...');
    expect(typeof result.scannedRecords).toBe('number');
    expect(result.scannedRecords).toBeGreaterThan(0);
    expect(typeof result.responseBytes).toBe('number');
    expect(result.responseBytes).toBeGreaterThan(0);
  });

  it('uses multi-page signed continuation to locate anchor and cover the full gap', async () => {
    // Head page: u4 a4 u5 a5
    // Older: u2 a2 u3 a3
    // Oldest: u1 a1
    // Anchor = u2 → gap is u2..a5 across pages
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u4'), assistant('msg_a4'),
        user('msg_u5'), assistant('msg_a5'),
      ], 'opaque_p1')],
      ['opaque_p1', pageResult([
        user('msg_u2'), assistant('msg_a2'),
        user('msg_u3'), assistant('msg_a3'),
      ], 'opaque_p2')],
      ['opaque_p2', pageResult([
        user('msg_u1'), assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      // Force at least two reconcile response pages: head page alone fills the budget.
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 10,
      totalByteLimit: 5 * 1024 * 1024,
    }));

    const first = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      anchor: 'msg_u2',
    });
    expect(first.ok).toBe(true);
    expect(first.resetRequired).toBe(false);
    expect(first.complete).toBe(false);
    expect(first.anchorFound).toBe(false);
    expect(first.capturedHeadMessageID).toBe('msg_a5');
    expect(typeof first.continuation).toBe('string');
    expect(first.continuation.startsWith('ocr2.')).toBe(true);
    expect(ids(first.records)).toEqual([
      'msg_u4', 'msg_a4', 'msg_u5', 'msg_a5',
    ]);

    const cont = decodeReconcileContinuation(first.continuation, codecOptions());
    expect(cont.ok).toBe(true);
    expect(cont.value).toMatchObject({
      runtime: RUNTIME,
      directory: '/repo',
      sessionID: 'ses_1',
      anchor: 'msg_u2',
      capturedHead: 'msg_a5',
    });
    expect(typeof cont.value.iat).toBe('number');
    expect(typeof cont.value.exp).toBe('number');

    const second = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      continuation: first.continuation,
    });
    expect(second.ok).toBe(true);
    expect(second.anchorFound).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.resetRequired).toBe(false);
    expect(second.continuation).toBe(null);
    expect(second.capturedHeadMessageID).toBe('msg_a5');
    expect(ids(second.records)).toEqual([
      'msg_u2', 'msg_a2', 'msg_u3', 'msg_a3',
    ]);

    // Full gap coverage across pages (client merges by ID).
    expect([...ids(second.records), ...ids(first.records)]).toEqual([
      'msg_u2', 'msg_a2', 'msg_u3', 'msg_a3',
      'msg_u4', 'msg_a4', 'msg_u5', 'msg_a5',
    ]);
  });

  it('rejects multipage continuation after TTL expiry', async () => {
    let now = FIXED_NOW;
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u4'), assistant('msg_a4'),
        user('msg_u5'), assistant('msg_a5'),
      ], 'opaque_p1')],
      ['opaque_p1', pageResult([
        user('msg_u2'), assistant('msg_a2'),
        user('msg_u3'), assistant('msg_a3'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 10,
      totalByteLimit: 5 * 1024 * 1024,
      clock: () => now,
      continuationTtlMs: 60_000,
    }));

    const first = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      anchor: 'msg_u2',
    });
    expect(first.ok).toBe(true);
    expect(typeof first.continuation).toBe('string');

    now = FIXED_NOW + 61_000;
    const second = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      continuation: first.continuation,
    });
    expect(second).toEqual({ ok: false, error: 'invalid_continuation' });
  });

  it('rejects continuation signed with a different secret', async () => {
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u2'), assistant('msg_a2'),
        user('msg_u3'), assistant('msg_a3'),
      ], 'opaque_p1')],
      ['opaque_p1', pageResult([
        user('msg_u1'), assistant('msg_a1'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const issuer = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 2,
      pageByteLimit: 1024 * 1024,
      continuationSecret: TEST_SECRET,
    }));
    const verifier = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 2,
      pageByteLimit: 1024 * 1024,
      continuationSecret: OTHER_SECRET,
    }));

    const first = await issuer.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      anchor: 'msg_u1',
    });
    expect(first.ok).toBe(true);
    expect(typeof first.continuation).toBe('string');

    const second = await verifier.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      continuation: first.continuation,
    });
    expect(second).toEqual({ ok: false, error: 'invalid_continuation' });
  });

  it('returns HTTP-success shaped resetRequired when anchor is missing through history start', async () => {
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'), assistant('msg_a1'),
        user('msg_u2'), assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage));

    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_deleted',
    });

    expect(result.ok).toBe(true);
    expect(result.resetRequired).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.anchorFound).toBe(false);
    expect(result.continuation).toBe(null);
    expect(Array.isArray(result.records)).toBe(true);
  });

  it('returns resetRequired when total page budget is exhausted before anchor', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return pageResult([
        user(`msg_u${n}`),
        assistant(`msg_a${n}`),
      ], `opaque_${n}`);
    });
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 2,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 2,
      totalByteLimit: 5 * 1024 * 1024,
    }));

    const first = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_never',
    });
    expect(first.ok).toBe(true);
    expect(first.resetRequired).toBe(false);
    expect(first.complete).toBe(false);
    expect(typeof first.continuation).toBe('string');
    expect(first.continuation.startsWith('ocr2.')).toBe(true);

    const second = await service.reconcile({
      sessionID: 'ses_1',
      continuation: first.continuation,
    });
    // totalPageLimit=2: second emitted page hits the round budget without anchor.
    expect(second.ok).toBe(true);
    expect(second.resetRequired).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.anchorFound).toBe(false);
    expect(second.continuation).toBe(null);
  });

  it('enforces per-page record budget', async () => {
    const many = [];
    for (let i = 1; i <= 10; i += 1) {
      many.push(user(`msg_u${i}`), assistant(`msg_a${i}`));
    }
    const pages = new Map([
      [undefined, pageResult(many, null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 20,
      totalByteLimit: 5 * 1024 * 1024,
    }));

    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_u1',
    });
    expect(result.ok).toBe(true);
    expect(result.records.length).toBeLessThanOrEqual(4);
    expect(result.complete).toBe(false);
    expect(typeof result.continuation).toBe('string');
    expect(result.continuation.startsWith('ocr2.')).toBe(true);
  });

  it('enforces per-page byte budget', async () => {
    const bulky = (id) => assistant(id, [{ type: 'text', text: 'x'.repeat(200) }]);
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u1'),
        bulky('msg_a1'),
        bulky('msg_a2'),
        bulky('msg_a3'),
        bulky('msg_a4'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 50,
      pageByteLimit: 500,
      totalPageLimit: 20,
      totalByteLimit: 5 * 1024 * 1024,
    }));

    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_u1',
    });
    expect(result.ok).toBe(true);
    expect(result.responseBytes).toBeLessThanOrEqual(500);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.length).toBeLessThan(5);
  });

  it('rejects continuation that does not bind runtime/directory/session/anchor/head', async () => {
    const fetchPage = vi.fn(async () => pageResult([user('msg_u1')], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage));

    const foreign = encodeReconcileContinuation({
      runtime: 'other-runtime',
      directory: '/repo',
      sessionID: 'ses_1',
      anchor: 'msg_u1',
      capturedHead: 'msg_u1',
      scanBefore: null,
      returnedThroughID: 'msg_u1',
      scannedRecords: 1,
      scannedBytes: 10,
      pagesEmitted: 1,
    }, codecOptions());

    const result = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      continuation: foreign,
    });
    expect(result).toEqual({ ok: false, error: 'invalid_continuation' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('rejects continuation when directory or sessionID query does not match token', async () => {
    const token = encodeReconcileContinuation({
      runtime: RUNTIME,
      directory: '/repo',
      sessionID: 'ses_1',
      anchor: 'msg_u1',
      capturedHead: 'msg_a1',
      scanBefore: 'opaque',
      returnedThroughID: 'msg_a1',
      scannedRecords: 2,
      scannedBytes: 20,
      pagesEmitted: 1,
    }, codecOptions());
    const fetchPage = vi.fn(async () => pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage));

    const wrongDir = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/other',
      continuation: token,
    });
    expect(wrongDir).toEqual({ ok: false, error: 'invalid_continuation' });

    const wrongSession = await service.reconcile({
      sessionID: 'ses_other',
      directory: '/repo',
      continuation: token,
    });
    expect(wrongSession).toEqual({ ok: false, error: 'invalid_continuation' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('rejects tampered multipage continuation at the service boundary', async () => {
    const pages = new Map([
      [undefined, pageResult([
        user('msg_u4'), assistant('msg_a4'),
        user('msg_u5'), assistant('msg_a5'),
      ], 'opaque_p1')],
      ['opaque_p1', pageResult([
        user('msg_u2'), assistant('msg_a2'),
      ], null)],
    ]);
    const fetchPage = vi.fn(async ({ before }) => pages.get(before) ?? pageResult([], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage, {
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
    }));

    const first = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      anchor: 'msg_u2',
    });
    expect(first.ok).toBe(true);
    const [, payloadPart, macPart] = first.continuation.split('.');
    const raw = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    raw.scannedRecords = 9999;
    const tamperedPayload = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
    const tampered = `ocr2.${tamperedPayload}.${macPart}`;

    const second = await service.reconcile({
      sessionID: 'ses_1',
      directory: '/repo',
      continuation: tampered,
    });
    expect(second).toEqual({ ok: false, error: 'invalid_continuation' });
  });

  it('returns invalid_anchor when first request omits anchor', async () => {
    const fetchPage = vi.fn();
    const service = createSessionReconcileService(serviceOptions(fetchPage));
    const result = await service.reconcile({ sessionID: 'ses_1' });
    expect(result).toEqual({ ok: false, error: 'invalid_anchor' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('maps upstream fetch failures to structured upstream error', async () => {
    const fetchPage = vi.fn(async () => {
      const error = new Error('connection refused');
      error.code = 'upstream';
      throw error;
    });
    const service = createSessionReconcileService(serviceOptions(fetchPage));
    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_u1',
    });
    expect(result).toEqual({ ok: false, error: 'upstream' });
  });

  it('maps unavailable OpenCode to unavailable error code', async () => {
    const fetchPage = vi.fn(async () => {
      const error = new Error('service unavailable');
      error.code = 'unavailable';
      error.status = 503;
      throw error;
    });
    const service = createSessionReconcileService(serviceOptions(fetchPage));
    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_u1',
    });
    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });

  it('forwards AbortSignal to fetchPage', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => pageResult([
      user('msg_u1'), assistant('msg_a1'),
    ], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage));

    await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_u1',
      signal: controller.signal,
    });

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('natural exhaustion without anchor is still ok:true (HTTP 200 path)', async () => {
    const fetchPage = vi.fn(async () => pageResult([
      user('msg_u1'), assistant('msg_a1'),
    ], null));
    const service = createSessionReconcileService(serviceOptions(fetchPage));
    const result = await service.reconcile({
      sessionID: 'ses_1',
      anchor: 'msg_missing',
    });
    expect(result.ok).toBe(true);
    expect(result.resetRequired).toBe(true);
  });
});
