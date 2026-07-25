import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const uiRequire = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const { QueryClient } = uiRequire('@tanstack/react-query');
const prefix = '/api/openchamber/message-queue';
const fixtures = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (check, timeout = 2_000) => {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) { try { return await check(); } catch (caught) { error = caught; await sleep(10); } }
  throw error;
};
const item = (id, directory = '/repo', sessionID = 'session', extra = {}) => ({
  requestID: `request-${id}`, scope: { directory, sessionID }, item: {
    queueItemID: `item-${id}`, operationID: `operation-${id}`, messageID: `msg_seed_${id}`,
    content: `content-${id}`, composerDocument: { text: `content-${id}`, references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' }, attachments: [], attachmentIssues: [], createdAt: Date.now(), ...extra,
  },
});

const fixture = async ({ adapter = {}, runtimeConfig = { apiBaseUrl: 'http://runtime-a' }, onRevisionTip = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cutover-')); fixtures.add(root);
  const config = { current: runtimeConfig };
  const sent = [];
  const fake = {
    captureRuntime: () => ({ token: config.current.apiBaseUrl }),
    checkEligibility: async () => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0000000000' }),
    createMessageID: (() => { let number = 0; return () => `msg_${String(++number).padStart(10, '0')}`; })(),
    materializeAttachments: async () => [],
    send: async (context) => { sent.push(context); return { ok: true }; },
    findMessage: async () => ({ found: false }),
    ...adapter,
  };
  const runtime = createMessageQueueRuntime({ dbPath: path.join(root, 'queue.sqlite'), attachmentRoot: path.join(root, 'attachments'), adapter: fake, workerID: `fixture-${process.pid}`, getRuntimeConfig: () => config.current, onRevisionTip });
  await runtime.startPaused();
  const app = express(); app.use(express.json()); registerMessageQueueRoutes(app, { messageQueueService: runtime.service, messageQueueRuntime: runtime });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
  const request = async (pathname, init = {}) => {
    const response = await fetch(`${base}${pathname}`, init);
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.code), { status: response.status, code: body.code });
    return body;
  };
  let closing;
  const close = () => closing ??= (async () => { await runtime.stop(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); })();
  return { root, runtime, service: runtime.service, adapter: fake, config, sent, request, close };
};

afterEach(async () => { for (const root of [...fixtures]) { fixtures.delete(root); fs.rmSync(root, { recursive: true, force: true }); } });

describe('Phase 2 decisive production cutover fixture', () => {
  it('恢复重启前的 queued 行，并保持默认 shadow authority', async () => {
    const f = await fixture();
    try {
      const admitted = f.service.admit(item('restart'));
      expect(f.service.getAuthority()).toMatchObject({ authority: 'shadow', generation: 0 });
      await f.runtime.stop();
      const reopened = createMessageQueueRuntime({ dbPath: path.join(f.root, 'queue.sqlite'), attachmentRoot: path.join(f.root, 'attachments'), adapter: f.adapter, workerID: 'reopened', getRuntimeConfig: () => f.config.current });
      await reopened.startPaused();
      expect(reopened.service.getScope(admitted.scopeID).items).toMatchObject([{ queueItemID: 'item-restart', status: 'queued' }]);
      await reopened.stop();
    } finally { await f.close(); }
  }, 10_000);

  it('通过两个独立 QueryClient surface 经 snapshot 收敛 revision tip，并在 fetch 失败时保留旧快照', async () => {
    const f = await fixture();
    try {
      const a = new QueryClient(), b = new QueryClient();
      const load = async (client, fail = false) => { if (fail) throw new Error('network'); const snapshot = await f.request(prefix); client.setQueryData(['surface', 'snapshot'], snapshot); return snapshot; };
      const first = f.service.admit(item('a')); f.service.admit(item('b'));
      await load(a); await load(b);
      const scope = f.service.getScope(first.scopeID); const edited = f.service.edit({ requestID: 'edit-a', queueItemID: 'item-a', expectedRevision: scope.revision, expectedRowVersion: scope.items[0].rowVersion, item: { content: 'edited-a' } });
      const current = f.service.getScope(first.scopeID); f.service.reorder({ requestID: 'order', scopeID: first.scopeID, expectedRevision: edited.revision, queueItemIDs: current.items.map((entry) => entry.queueItemID).reverse() });
      const afterOrder = f.service.getScope(first.scopeID); f.service.remove({ requestID: 'remove-b', queueItemID: 'item-b', expectedRevision: afterOrder.revision, expectedRowVersion: afterOrder.items.find((entry) => entry.queueItemID === 'item-b').rowVersion });
      expect(f.service.snapshot().revision).toBeGreaterThan(first.revision);
      await load(b); const old = b.getQueryData(['surface', 'snapshot']); await expect(load(b, true)).rejects.toThrow('network'); expect(b.getQueryData(['surface', 'snapshot'])).toEqual(old);
      expect(a.getQueryData(['surface', 'snapshot']).revision).toBeLessThan(b.getQueryData(['surface', 'snapshot']).revision);
    } finally { await f.close(); }
  }, 10_000);

  it('同 scope FIFO dispatch 且不同 scope 并发', async () => {
    const releases = []; const dispatched = []; let active = 0; let maximum = 0;
    const f = await fixture({ adapter: { send: async (context) => { dispatched.push(context); active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => releases.push(resolve)); active -= 1; return { ok: true }; } } });
    try {
      f.service.admit(item('one')); f.service.admit(item('two')); f.service.admit(item('other', '/other', 'other'));
      f.service.setAuthority({ authority: 'active', expectedGeneration: 0 });
      const running = f.runtime.startActive(); await eventually(() => expect(releases).toHaveLength(2));
      expect(dispatched.map((entry) => entry.queueItemID)).toEqual(expect.arrayContaining(['item-one', 'item-other'])); expect(dispatched.map((entry) => entry.queueItemID)).not.toContain('item-two'); expect(maximum).toBe(2);
      releases.splice(0).forEach((release) => release()); await running; dispatched.forEach((entry) => f.runtime.worker.confirmByMessage({ directory: entry.directory, sessionID: entry.sessionID, messageID: entry.messageID })); void f.runtime.wake(); await eventually(() => expect(dispatched.map((entry) => entry.queueItemID)).toContain('item-two'));
      releases.splice(0).forEach((release) => release());
    } finally { await f.close(); }
  }, 10_000);

  it('会话暂不可发送时保持 queued 行和 scope revision 稳定', async () => {
    let eligibilityChecks = 0;
    const revisionTips = [];
    const f = await fixture({ adapter: { checkEligibility: async () => { eligibilityChecks += 1; return { available: true, idle: false, settled: false, latestMessageID: 'msg_0000000000' }; } }, onRevisionTip: (revision) => revisionTips.push(revision) });
    try {
      const admitted = f.service.admit(item('ineligible-stable'));
      f.service.setAuthority({ authority: 'active', expectedGeneration: 0 });
      const before = f.service.getScope(admitted.scopeID);
      const beforeGlobalRevision = f.service.snapshot().revision;
      revisionTips.length = 0;
      await f.runtime.startActive();
      await eventually(() => expect(eligibilityChecks).toBeGreaterThan(0));
      const after = f.service.getScope(admitted.scopeID);
      expect(after.revision).toBe(before.revision);
      expect(after.items[0]).toMatchObject({ status: 'queued', rowVersion: before.items[0].rowVersion, dueAt: before.items[0].dueAt });
      expect(f.service.snapshot().revision).toBe(beforeGlobalRevision);
      expect(revisionTips).toHaveLength(0);
      expect(f.sent).toHaveLength(0);
    } finally { await f.close(); }
  }, 10_000);

  it('HTTP 在发送挂起时接受客户端 promote 与 waiting reorder，同时保持另一 scope 并发', async () => {
    const releases = []; const activeBySession = new Map(); const maxBySession = new Map(); let active = 0; let maximum = 0;
    const f = await fixture({ adapter: { send: async (context) => {
      const session = `${context.directory}\0${context.sessionID}`; const count = (activeBySession.get(session) ?? 0) + 1; activeBySession.set(session, count); maxBySession.set(session, Math.max(maxBySession.get(session) ?? 0, count)); active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => releases.push(resolve)); active -= 1; activeBySession.set(session, count - 1); return { ok: true };
    } } });
    try {
      const first = f.service.admit(item('locked-head')); f.service.admit(item('locked-tail')); f.service.admit(item('locked-other', '/other', 'other'));
      f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); const running = f.runtime.startActive(); await eventually(() => expect(releases).toHaveLength(2));
      let scope = f.service.getScope(first.scopeID); const tail = scope.items.find((entry) => entry.queueItemID === 'item-locked-tail');
      await expect(f.request(`${prefix}/items/${tail.queueItemID}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestID: 'locked-promote', expectedRevision: scope.revision, expectedRowVersion: tail.rowVersion }) })).resolves.toMatchObject({ queueItemID: tail.queueItemID });
      scope = f.service.getScope(first.scopeID);
      await expect(f.request(`${prefix}/scopes/${first.scopeID}/order`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestID: 'locked-reorder', expectedRevision: scope.revision, queueItemIDs: scope.items.map((entry) => entry.queueItemID).reverse() }) })).resolves.toMatchObject({ scopeID: first.scopeID });
      expect(f.service.getScope(first.scopeID).items.map((entry) => entry.queueItemID)).toEqual(['item-locked-head', 'item-locked-tail']);
      expect(maxBySession.get('/repo\0session')).toBe(1); expect(maxBySession.get('/other\0other')).toBe(1); expect(maximum).toBe(2);
      releases.splice(0).forEach((release) => release()); await running;
    } finally { await f.close(); }
  }, 10_000);

  it('上传 Blob 后重启，worker 保留 parts 内容、顺序、MIME 与文件名', async () => {
    let parts;
    const f = await fixture({ adapter: { send: async (context) => { parts = context.parts; return { ok: true }; } } });
    try {
      f.adapter.materializeAttachments = (queued, options) => Promise.all(queued.attachments.map((attachment) => f.runtime.attachmentStore.readAttachment(attachment, queued, options))).then((files) => [{ type: 'text', text: queued.content }, ...files]);
      const upload = await f.request(`${prefix}/attachments/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const bytes = Buffer.from('blob-content'); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      await f.request(`${prefix}/attachments/uploads/${upload.uploadID}`, { method: 'PUT', headers: { 'content-length': String(bytes.length), 'x-message-queue-upload-token': upload.uploadToken, 'x-message-queue-sha256': hash }, body: bytes });
      const admitted = f.service.admit(item('blob', '/repo', 'session', { attachments: [{ attachmentID: 'file', occurrenceRefID: ['root', 'file'], filename: 'proof.txt', mimeType: 'text/plain', size: bytes.length, source: 'local', locator: { kind: 'upload', uploadID: upload.uploadID } }] }));
      await f.runtime.stop(); const restarted = createMessageQueueRuntime({ dbPath: path.join(f.root, 'queue.sqlite'), attachmentRoot: path.join(f.root, 'attachments'), adapter: f.adapter, workerID: 'blob-restart', getRuntimeConfig: () => f.config.current }); await restarted.startPaused(); restarted.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await restarted.startActive();
      await eventually(() => expect(parts).toHaveLength(2)); expect(parts[1]).toMatchObject({ type: 'file', filename: 'proof.txt', mime: 'text/plain' }); expect(Buffer.from(parts[1].url.split(',')[1], 'base64').toString()).toBe('blob-content'); expect(admitted.queueItemID).toBe('item-blob'); await restarted.stop();
    } finally { await f.close(); }
  }, 10_000);

  it('HTTP 以权威 upload 元数据限制单项 50 MiB 附件总量', async () => {
    const f = await fixture(); const mib = 1024 * 1024;
    try {
      const ready = (id, size) => { const upload = f.service.createAttachmentUpload(); f.service.markAttachmentReady({ ...upload, objectHash: `total-${id}`, storageKey: `objects/total-${id}`, sizeBytes: size }); return upload; };
      const a = ready('a', 25 * mib), b = ready('b', 25 * mib), c = ready('c', 1);
      const canonical = (upload, id, size) => ({ attachmentID: id, occurrenceRefID: ['root', id], filename: `${id}.bin`, mimeType: 'application/octet-stream', size, source: 'local', locator: { kind: 'upload', uploadID: upload.uploadID } });
      await expect(f.request(`${prefix}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item('total-http-ok', '/repo', 'total', { attachments: [canonical(a, 'a', 25 * mib), canonical(b, 'b', 25 * mib)] })) })).resolves.toMatchObject({ queueItemID: 'item-total-http-ok' });
      await expect(f.request(`${prefix}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item('total-http-over', '/repo', 'total-over', { migrationImport: true, attachments: [a, b, c].map((upload, index) => ({ uploadID: upload.uploadID, name: `legacy-${index}` })), attachmentIssues: [] })) })).rejects.toMatchObject({ status: 413, code: 'attachment_total_limit' });
    } finally { await f.close(); }
  }, 10_000);

  it('definitive fail 可 manual retry，ambiguous reconcile 禁止重复 POST', async () => {
    let calls = 0;
    const f = await fixture({ adapter: { send: async () => ({ status: ++calls === 1 ? 400 : 503 }), findMessage: async () => ({ found: true }) } });
    try {
      const admitted = f.service.admit(item('failure')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.startActive(); await f.runtime.wake();
      let scope = f.service.getScope(admitted.scopeID); expect(scope.items[0].status).toBe('failed'); f.service.manualSend({ requestID: 'manual', queueItemID: 'item-failure', expectedRevision: scope.revision, expectedRowVersion: scope.items[0].rowVersion }); await f.runtime.wake(); await eventually(() => expect(calls).toBe(2));
      await f.runtime.wake(); await sleep(20); expect(calls).toBe(2); expect(f.service.snapshot().scopes[0].itemCount).toBe(0);
    } finally { await f.close(); }
  }, 10_000);

  it('event confirmation 与 POST settlement 竞态只完成一次', async () => {
    let release;
    let context;
    const f = await fixture({ adapter: { send: async (value) => { context = value; return new Promise((resolve) => { release = () => resolve({ ok: true }); }); } } });
    try {
      const admitted = f.service.admit(item('race')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.startActive(); await eventually(() => expect(release).toBeTypeOf('function'));
      f.runtime.worker.confirmByMessage({ directory: '/repo', sessionID: 'session', messageID: context.messageID }); release(); await f.runtime.wake(); expect(f.service.snapshot().scopes).toMatchObject([{ scopeID: admitted.scopeID, itemCount: 0 }]);
    } finally { await f.close(); }
  }, 10_000);

  it('POST accepted 后持久化保留 reconciling 行', async () => {
    const f = await fixture();
    try {
      const admitted = f.service.admit(item('accepted')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.startActive(); await eventually(() => expect(f.sent).toHaveLength(1));
      expect(f.service.getScope(admitted.scopeID).items).toMatchObject([{ queueItemID: admitted.queueItemID, status: 'reconciling', messageID: expect.stringMatching(/^msg_/) }]);
    } finally { await f.close(); }
  }, 10_000);

  it('精确 message.updated 确认 accepted 行后完成删除', async () => {
    const f = await fixture();
    try {
      const admitted = f.service.admit(item('accepted-event')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.startActive(); await eventually(() => expect(f.sent).toHaveLength(1));
      const current = f.service.getScope(admitted.scopeID).items[0];
      f.runtime.worker.confirmByMessage({ directory: current.directory, sessionID: current.sessionID, messageID: current.messageID });
      expect(f.service.snapshot().scopes).toMatchObject([{ scopeID: admitted.scopeID, itemCount: 0 }]);
    } finally { await f.close(); }
  }, 10_000);

  it('runtime A 到 B 切换时 accepted attempt 保留在 A 的 reconciliation', async () => {
    let release;
    const f = await fixture({ adapter: { send: async () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) } });
    try {
      f.service.admit(item('switch')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.startActive(); await eventually(() => expect(release).toBeTypeOf('function')); f.config.current = { apiBaseUrl: 'http://runtime-b' }; release(); await f.runtime.wake();
      expect(f.service.snapshot().scopes).toEqual([]); f.config.current = { apiBaseUrl: 'http://runtime-a' }; expect(f.service.snapshot().scopes[0].itemCount).toBe(1);
    } finally { await f.close(); }
  }, 10_000);

  it('worktree deletion 锁定写入，支持 rollback 与 commit', async () => {
    const f = await fixture();
    try {
      const admitted = f.service.admit(item('tree')); const prepared = f.service.prepareWorktreeDeletion({ requestID: 'prepare', directory: '/repo' });
      expect(() => f.service.edit({ requestID: 'locked', queueItemID: 'item-tree', expectedRevision: prepared.revision, expectedRowVersion: 1, item: { content: 'x' } })).toThrow(expect.objectContaining({ code: 'scope_locked' }));
      f.service.rollbackWorktreeDeletion({ requestID: 'rollback', directory: '/repo', token: prepared.token }); const second = f.service.prepareWorktreeDeletion({ requestID: 'prepare-2', directory: '/repo' }); const committed = f.service.commitWorktreeDeletion({ requestID: 'commit', directory: '/repo', projectDirectory: '/project', token: second.token }); expect(committed.state).toBe('deleted'); expect(f.service.getScope(admitted.scopeID).worktreeState).toBe('deleted');
    } finally { await f.close(); }
  }, 10_000);

  it('shadow import migration statuses 保留且 activation gate 显式开启', async () => {
    const f = await fixture();
    try {
      const imported = f.service.admit(item('import', '/repo', 'session', { migrationImport: true, migrationState: { status: 'reconciling', attemptCount: 2, reconciliationNextCheckAt: Date.now() }, attachmentIssues: [{ code: 'legacy' }] }));
      expect(f.service.getScope(imported.scopeID).items[0]).toMatchObject({ status: 'unresolved', attemptCount: 2, attachmentIssues: [{ code: 'legacy' }] }); expect(f.service.getAuthority().authority).toBe('shadow'); expect(f.service.setAuthority({ authority: 'active', expectedGeneration: 0 })).toMatchObject({ authority: 'active', generation: 1 });
    } finally { await f.close(); }
  }, 10_000);

  it('manual arbitrary-row promotion 把 recoverable 行提升到 scope head', async () => {
    const f = await fixture();
    try {
      const first = f.service.admit(item('head')); f.service.admit(item('tail')); let scope = f.service.getScope(first.scopeID); const tail = scope.items[1]; f.service.manualSend({ requestID: 'promote', queueItemID: tail.queueItemID, expectedRevision: scope.revision, expectedRowVersion: tail.rowVersion }); scope = f.service.getScope(first.scopeID); expect(scope.items.map((entry) => entry.queueItemID)).toEqual(['item-tail', 'item-head']);
    } finally { await f.close(); }
  }, 10_000);

  it('manual busy promotion sends once and persists reconciliation from its durable intent', async () => {
    const f = await fixture({ adapter: { checkEligibility: async () => ({ available: true, idle: false, settled: false, latestMessageID: 'msg_0000000000' }) } });
    try {
      const admitted = f.service.admit(item('manual-busy')); const scope = f.service.getScope(admitted.scopeID); f.service.manualSend({ requestID: 'manual-busy-send', queueItemID: 'item-manual-busy', expectedRevision: scope.revision, expectedRowVersion: scope.items[0].rowVersion }); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 });
      await f.runtime.startActive(); await eventually(() => expect(f.sent).toHaveLength(1)); await f.runtime.wake(); expect(f.sent).toHaveLength(1); expect(f.service.snapshot().scopes[0].itemCount).toBe(1);
    } finally { await f.close(); }
  }, 10_000);

  it('shutdown 等待 active task drain 后关闭 SQLite 与 HTTP listener', async () => {
    let release;
    const f = await fixture({ adapter: { send: async () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) } });
    try {
      f.service.admit(item('drain')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); void f.runtime.startActive(); await eventually(() => expect(release).toBeTypeOf('function')); let stopped = false; const stopping = f.runtime.stop().then(() => { stopped = true; }); await sleep(20); expect(stopped).toBe(false); release(); await stopping; expect(stopped).toBe(true);
    } finally { await f.close(); }
  }, 10_000);
});
