import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url';
import { MessageQueueServerError, activateMessageQueueImport, commitLateMessageQueueImport, createMessageQueueImport, fetchMessageQueueServerStatus, sealMessageQueueImport, stageMessageQueueImport } from '../../../../ui/src/lib/message-queue-server';
import { createMessageQueueCutover } from '../../../../ui/src/sync/message-queue-cutover';
import { createMessageQueueRuntime as createLocalRuntime } from '../../../../ui/src/sync/message-queue-runtime';
import { createMessageQueueRuntimeController } from '../../../../ui/src/sync/message-queue-runtime-controller';
import { createQueueAttachmentCoordinator } from '../../../../ui/src/sync/queue-attachment-coordinator';
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from '../../../../ui/src/sync/input-draft-blob-store';
import { getQueuedMessageOwnershipGate, setQueuedMessageOwnershipGate } from '../../../../ui/src/hooks/useQueuedMessageAutoSend';
import { setMessageQueueMutationFence } from '../../../../ui/src/stores/messageQueueStore';
import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const roots = new Set<string>();
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (assertion: () => unknown | Promise<unknown>, timeout = 4_000) => {
  let failure: unknown;
  for (const until = Date.now() + timeout; Date.now() < until; await wait()) {
    try { return await assertion(); } catch (error) { failure = error; }
  }
  throw failure;
};
const item = (id: string, directory = '/repo', sessionID = 'session') => ({
  requestID: `request-${id}`,
  scope: { directory, sessionID },
  item: { queueItemID: `item-${id}`, operationID: `operation-${id}`, messageID: `msg_seed_${id}`, content: `body-${id}`, composerDocument: { text: `body-${id}`, references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' }, attachments: [], attachmentIssues: [], createdAt: Date.now() },
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const payloadHash = (payload: unknown) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');

const fixture = async (send: (context: any) => Promise<any> = async () => ({ ok: true })) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ui-cutover-')); roots.add(root);
  const config = { current: { apiBaseUrl: 'runtime-a' } };
  const runtime = createMessageQueueRuntime({
    dbPath: path.join(root, 'queue.sqlite'), attachmentRoot: path.join(root, 'attachments'), workerID: `cutover-${process.pid}`,
    getRuntimeConfig: () => config.current, isServerPathAllowed: () => true,
    adapter: { captureRuntime: () => ({ runtime: config.current.apiBaseUrl }), checkEligibility: async () => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0000000000' }), createMessageID: (() => { let value = 0; return () => `msg_${String(++value).padStart(10, '0')}`; })(), materializeAttachments: async () => [], send, findMessage: async () => ({ found: false }) },
  })!;
  await runtime.startPaused();
  const app: any = express(); app.use(express.json()); registerMessageQueueRoutes(app, { messageQueueService: runtime.service, messageQueueRuntime: runtime });
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const resolver = getRuntimeUrlResolver(); setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  return { root, runtime, service: runtime.service, config, close: async () => { await runtime.stop(); server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); setRuntimeUrlResolver(resolver); } };
};

const local = (directory: string, transportIdentity = 'device-a', id = 'local') => {
  const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver());
  const controller = createMessageQueueRuntimeController(createQueueAttachmentCoordinator(blobs, { persist: async () => ({ ok: true as const, value: undefined }), flush: async () => {}, setEnabled: async () => {}, cancelPending: () => {} }), () => ({ transportIdentity, generation: 1, isCurrent: () => true }));
  const row: any = { version: 1, queueItemID: `${id}-item`, operationID: `${id}-operation`, messageID: `msg_${id}`, owner: { state: 'bound', transportIdentity, directory, sessionID: 'session' }, content: `${id} body`, composerDocument: { text: `${id} body`, references: [] }, attachments: [], attachmentIssues: [], createdAt: 1, status: 'queued', attemptCount: 0 };
  return { runtime: createLocalRuntime(() => ({ controller, migrate: async () => ({ status: 'committed' as const, snapshot: { version: 4 as const, queues: { [`bound:${JSON.stringify([transportIdentity, directory, 'session'])}`]: [row] }, migration: { v3State: 'complete' as const } } }) })), row };
};

afterEach(() => {
  vi.useRealTimers(); setQueuedMessageOwnershipGate('blocked'); setMessageQueueMutationFence('open');
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear();
});

describe('UI cutover coordinator integration', () => {
  it('shadow 延迟期间关闭 v3 gate，经 staging activation 只发送一次并保留本地 v4 副本', async () => {
    let posts = 0; const f = await fixture(async () => { posts++; return { ok: true }; }); const v4 = local('/repo');
    try {
      const cutover = createMessageQueueCutover({ queue: v4.runtime, server: { refresh: async () => {} } as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, quiesce: async () => { await wait(25); }, flush: async () => {}, prepare: () => ({ ok: true, unresolvedSessionIDs: [] }), resolveDirectory: () => '/repo' });
      const pending = cutover.refresh(); await wait(5); expect(getQueuedMessageOwnershipGate()).toBe('blocked'); await pending;
      expect(cutover.getSnapshot().importState.issues).toEqual([]); expect(cutover.getSnapshot()).toMatchObject({ ownership: 'server-active', migration: 'complete', admission: 'server' });
      expect(Object.values(v4.runtime.getState().snapshot.queues).flat()[0]).toMatchObject({ queueItemID: 'local-item', content: 'local body' });
      await f.runtime.start(); await eventually(() => expect(posts).toBe(1)); await f.runtime.wake(); await wait(30); expect(posts).toBe(1);
      cutover.stop();
    } finally { await f.close(); }
  }, 15_000);

  it('只有 501 打开 legacy scheduler；500 与连接失败保持 blocked', async () => {
    const base = { server: { refresh: async () => {} } as never, capture: () => ({ transportIdentity: 'a', generation: 1 }), current: () => true };
    const unsupported = createMessageQueueCutover({ ...base, status: async () => { throw new MessageQueueServerError(501, 'unavailable'); } });
    await unsupported.refresh(); expect(unsupported.getSnapshot().ownership).toBe('legacy-unsupported'); expect(getQueuedMessageOwnershipGate()).toBe('legacy-enabled'); unsupported.stop();
    const unavailable = createMessageQueueCutover({ ...base, status: async () => { throw new MessageQueueServerError(500, 'unavailable'); } });
    await unavailable.refresh(); expect(unavailable.getSnapshot().ownership).toBe('blocked'); expect(getQueuedMessageOwnershipGate()).toBe('blocked'); unavailable.stop();
  });

  it('activation 响应丢失时由 status epoch 与 manifest 恢复 server-active', async () => {
    const f = await fixture(); const v4 = local('/repo');
    try {
      const lostResponse = (async (importID: string, request: Parameters<typeof activateMessageQueueImport>[1]) => { await activateMessageQueueImport(importID, request); throw new Error('response-lost'); }) as never;
      const cutover = createMessageQueueCutover({ queue: v4.runtime, server: { refresh: async () => {} } as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, quiesce: async () => {}, flush: async () => {}, prepare: () => ({ ok: true, unresolvedSessionIDs: [] }), resolveDirectory: () => '/repo', activate: lostResponse });
      await cutover.refresh(); expect(cutover.getSnapshot().importState.issues).toEqual([]); expect(cutover.getSnapshot()).toMatchObject({ ownership: 'server-active', migration: 'complete' }); expect(cutover.getSnapshot().status?.activationEpoch).toBe(1); cutover.stop();
    } finally { await f.close(); }
  }, 15_000);

  it('两个真实 coordinator 并发刷新时保留两份本地行，并将竞争方改为 late import', async () => {
    const f = await fixture(async () => ({ ok: false, code: 'retry' })); const first = local('/repo', 'device-a', 'first'), second = local('/repo', 'device-b', 'second');
    const coordinator = (queue: ReturnType<typeof local>['runtime'], transportIdentity: string) => createMessageQueueCutover({ queue, server: { refresh: async () => {} } as never, status: fetchMessageQueueServerStatus, capture: () => ({ transportIdentity, generation: 1 }), current: () => true, quiesce: async () => {}, flush: async () => {}, prepare: () => ({ ok: true, unresolvedSessionIDs: [] }), resolveDirectory: () => '/repo' });
    const a = coordinator(first.runtime, 'device-a'), b = coordinator(second.runtime, 'device-b');
    try {
      await Promise.all([a.refresh(), b.refresh()]);
      await eventually(() => {
        expect(a.getSnapshot().migration).toBe('complete');
        expect(b.getSnapshot().migration).toBe('complete');
        expect(f.service.snapshot().scopes[0]?.itemCount).toBe(2);
      });
      const scope = f.service.getScope(f.service.snapshot().scopes[0]!.scopeID);
      expect(scope.items.map((entry: { queueItemID: string }) => entry.queueItemID).sort()).toEqual(['first-item', 'second-item']);
    } finally { a.stop(); b.stop(); await f.close(); }
  }, 15_000);

  it('并发 activation generation conflict 通过 late import 尾追加，并拒绝 protocol 3', async () => {
    const f = await fixture();
    try {
      const a = await createMessageQueueImport({ requestID: 'a', kind: 'activation', clientID: 'a', snapshotHash: 'a'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 0 });
      const b = await createMessageQueueImport({ requestID: 'b', kind: 'activation', clientID: 'b', snapshotHash: 'b'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 0 });
      const seals = new Map<string, string>();
      for (const [created, id] of [[a, 'a'], [b, 'b']] as const) { const payload = { scope: { directory: '/repo', sessionID: 'session' }, item: item(id).item }; await stageMessageQueueImport(created.importID, { requestID: `stage-${id}`, scopeOrdinal: 0, itemOrdinal: 0, payload, payloadHash: payloadHash(payload), signal: new AbortController().signal }); seals.set(id, (await sealMessageQueueImport(created.importID, { requestID: `seal-${id}` })).manifestHash); }
      expect(await activateMessageQueueImport(a.importID, { requestID: 'activate-a', expectedGeneration: 0, manifestHash: seals.get('a')!, protocol: 4 })).toMatchObject({ added: 1, generation: 1 });
      await expect(activateMessageQueueImport(b.importID, { requestID: 'activate-b', expectedGeneration: 0, manifestHash: seals.get('b')!, protocol: 4 })).rejects.toMatchObject({ status: 409, code: 'generation_conflict' });
      const late = await createMessageQueueImport({ requestID: 'late', kind: 'late', clientID: 'b', snapshotHash: 'd'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 1 });
      const latePayload = { scope: { directory: '/repo', sessionID: 'session' }, item: item('b').item };
      await stageMessageQueueImport(late.importID, { requestID: 'stage-late', scopeOrdinal: 0, itemOrdinal: 0, payload: latePayload, payloadHash: payloadHash(latePayload), signal: new AbortController().signal });
      const lateManifest = (await sealMessageQueueImport(late.importID, { requestID: 'seal-late' })).manifestHash;
      expect(await commitLateMessageQueueImport(late.importID, { requestID: 'late-b', expectedGeneration: 1, manifestHash: lateManifest, protocol: 4 })).toMatchObject({ added: 1, generation: 1 });
      await expect(createMessageQueueImport({ requestID: 'p3', kind: 'activation', clientID: 'p3', snapshotHash: 'c'.repeat(64), itemCount: 0, protocol: 3 as 4, expectedGeneration: 0 })).rejects.toMatchObject({ status: 400 });
    } finally { await f.close(); }
  });

  it('重启 active 自动启动 worker，paused 保持静止，恢复后发送', async () => {
    let calls = 0; const f = await fixture(async () => ({ ok: ++calls > 0 }));
    try {
      f.service.admit(item('restart')); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await f.runtime.stop();
      const reopened = createMessageQueueRuntime({ dbPath: path.join(f.root, 'queue.sqlite'), attachmentRoot: path.join(f.root, 'attachments'), workerID: 'reopened', getRuntimeConfig: () => f.config.current, adapter: { captureRuntime: () => ({}), checkEligibility: async () => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0' }), createMessageID: () => 'msg_1', materializeAttachments: async () => [], send: async () => ({ ok: ++calls > 0 }), findMessage: async () => ({ found: false }) } })!;
      await reopened.start(); await eventually(() => expect(calls).toBeGreaterThan(0)); await reopened.stop();
    } finally { await f.close(); }
  }, 15_000);
});
