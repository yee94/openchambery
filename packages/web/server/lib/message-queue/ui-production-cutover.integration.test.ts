import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url';
import { abandonMessageQueueImport, activateMessageQueueImport, commitLateMessageQueueImport, createMessageQueueImport, downloadMessageQueueAttachment, fetchMessageQueueServerStatus, fetchMessageQueueSnapshot, pauseMessageQueueAuthority, resumeMessageQueueAuthority, sealMessageQueueImport, stageMessageQueueImport } from '../../../../ui/src/lib/message-queue-server';
import { readMessageQueueScope } from '../../../../ui/src/queries/messageQueueQueries';
import { createMessageQueueServerRuntime } from '../../../../ui/src/sync/message-queue-server-runtime';
import { createMessageQueueServerEditBridge } from '../../../../ui/src/sync/message-queue-server-edit-bridge';
import { admitServerQueueMessageAndConsumeResources, createServerQueueAdmissionCapture } from '../../../../ui/src/components/chat/queueAdmission';
import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const roots = new Set<string>();
const uiRequire = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const { QueryClient } = uiRequire('@tanstack/react-query') as { QueryClient: new () => any };
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (assertion: () => unknown | Promise<unknown>, timeout = 4_000) => {
  let failure: unknown;
  for (const until = Date.now() + timeout; Date.now() < until; await wait()) {
    try { return await assertion(); } catch (error) { failure = error; }
  }
  throw failure;
};
const admission = (id: string, directory = '/repo', sessionID = 'session', extra: Record<string, unknown> = {}) => ({
  requestID: `request-${id}`,
  scope: { directory, sessionID },
  item: { queueItemID: `item-${id}`, operationID: `operation-${id}`, messageID: `msg_seed_${id}`, content: `body-${id}`, composerDocument: { text: `body-${id}`, references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' }, attachments: [], attachmentIssues: [], createdAt: Date.now(), ...extra },
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const payloadHash = (payload: unknown) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');

const fixture = async (options: { send?: (context: any) => Promise<any>; failScopePage?: () => boolean } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ui-gate2-')); roots.add(root);
  const runtimeConfig = { current: { apiBaseUrl: 'runtime-a' } };
  const runtime = createMessageQueueRuntime({
    dbPath: path.join(root, 'queue.sqlite'), attachmentRoot: path.join(root, 'attachments'), workerID: `gate2-${process.pid}`,
    getRuntimeConfig: () => runtimeConfig.current, isServerPathAllowed: () => true,
    adapter: {
      captureRuntime: () => ({ key: runtimeConfig.current.apiBaseUrl }), checkEligibility: async () => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0000000000' }),
      createMessageID: (() => { let id = 0; return () => `msg_${String(++id).padStart(10, '0')}`; })(), materializeAttachments: async () => [],
      send: options.send ?? (async () => ({ ok: true })), findMessage: async () => ({ found: false }),
    },
  })!;
  await runtime.startPaused();
  const app: any = express(); app.use(express.json());
  app.use((request: any, response: any, next: any) => options.failScopePage?.() && request.path.includes('/scopes/') && request.query.offset === '8' ? response.status(503).json({ code: 'unavailable' }) : next());
  registerMessageQueueRoutes(app, { messageQueueService: runtime.service, messageQueueRuntime: runtime });
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const resolver = getRuntimeUrlResolver(); setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` }));
  const close = async () => { await runtime.stop(); server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); setRuntimeUrlResolver(resolver); };
  return { root, runtime, service: runtime.service, runtimeConfig, close };
};

/** Test stand-in for SSE tip waits: poll the snapshot until revision advances. */
const waitInvalidationBySnapshot = async (revision: number, options: { signal?: AbortSignal } = {}): Promise<'tip' | 'ready' | 'aborted'> => {
  while (!options.signal?.aborted) {
    try {
      if ((await fetchMessageQueueSnapshot(options.signal)).revision > revision) return 'tip';
    } catch {
      // Keep polling until the observer aborts or the tip appears.
    }
    await wait(20);
  }
  return 'aborted';
};
const surface = (client: any, identity: string, generation = 1) => createMessageQueueServerRuntime({
  client,
  capture: () => ({ transportIdentity: identity, generation }),
  current: (capture) => capture.transportIdentity === identity && capture.generation === generation,
  waitInvalidation: waitInvalidationBySnapshot,
});

afterEach(() => { vi.useRealTimers(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe('Gate 2 UI production cutover E2E', () => {
  it('通过真实 HTTP 激活空 import', async () => {
    const f = await fixture();
    try {
      const imported = await createMessageQueueImport({ requestID: 'empty-create', kind: 'activation', clientID: 'empty-client', snapshotHash: 'a'.repeat(64), itemCount: 0, protocol: 4, expectedGeneration: 0 });
      const sealed = await sealMessageQueueImport(imported.importID, { requestID: 'empty-seal' });
      expect(await activateMessageQueueImport(imported.importID, { requestID: 'empty-activate', expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 })).toMatchObject({ added: 0, generation: 1, activationEpoch: 1 });
    } finally { await f.close(); }
  });

  it('经真实 Express、SQLite 与 UI adapter 执行 Phase 3 import HTTP DTO 生命周期', async () => {
    const f = await fixture();
    try {
      const imported = await createMessageQueueImport({ requestID: 'activation-create', kind: 'activation', clientID: 'activation-client', snapshotHash: 'a'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 0 });
      const activationPayload = { scope: { directory: '/repo', sessionID: 'phase3-activation' }, item: admission('phase3-activation').item };
      expect(await stageMessageQueueImport(imported.importID, { requestID: 'activation-stage', scopeOrdinal: 0, itemOrdinal: 0, payload: activationPayload, payloadHash: payloadHash(activationPayload), signal: new AbortController().signal })).toEqual({ revision: expect.any(Number), importID: imported.importID, staged: true });
      const activationSeal = await sealMessageQueueImport(imported.importID, { requestID: 'activation-seal' });
      expect(activationSeal).toMatchObject({ state: 'sealed', itemCount: 1 });
      const activated = await activateMessageQueueImport(imported.importID, { requestID: 'activation-activate', expectedGeneration: 0, manifestHash: activationSeal.manifestHash, protocol: 4 });
      expect(activated).toMatchObject({ generation: 1, activationEpoch: 1, added: 1 });
      expect(await fetchMessageQueueServerStatus()).toMatchObject({ authority: 'active', generation: 1, activationEpoch: 1, activatedAt: expect.any(Number), protocol: 4 });

      const paused = await pauseMessageQueueAuthority({ expectedGeneration: activated.generation });
      expect(paused).toEqual({ authority: 'paused', generation: 2, revision: paused.revision });
      const resumed = await resumeMessageQueueAuthority({ expectedGeneration: paused.generation });
      expect(resumed).toEqual({ authority: 'active', generation: 3, revision: resumed.revision });

      const stagedImport = await createMessageQueueImport({ requestID: 'late-create', kind: 'late', clientID: 'late-client', snapshotHash: 'b'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: resumed.generation });
      const stagedPayload = { scope: { directory: '/repo', sessionID: 'phase3' }, item: admission('phase3').item };
      expect(await stageMessageQueueImport(stagedImport.importID, { requestID: 'late-stage', scopeOrdinal: 0, itemOrdinal: 0, payload: stagedPayload, payloadHash: payloadHash(stagedPayload), signal: new AbortController().signal })).toEqual({ revision: expect.any(Number), importID: stagedImport.importID, staged: true });
      const lateSeal = await sealMessageQueueImport(stagedImport.importID, { requestID: 'late-seal' });
      expect(await commitLateMessageQueueImport(stagedImport.importID, { requestID: 'late-commit', expectedGeneration: resumed.generation, manifestHash: lateSeal.manifestHash, protocol: 4 })).toMatchObject({ importID: stagedImport.importID, added: 1, generation: resumed.generation });

      const abandoned = await createMessageQueueImport({ requestID: 'abandon-create', kind: 'late', clientID: 'abandon-client', snapshotHash: 'c'.repeat(64), itemCount: 0, protocol: 4, expectedGeneration: resumed.generation });
      expect(await abandonMessageQueueImport(abandoned.importID, { requestID: 'abandon' })).toEqual({ revision: expect.any(Number), importID: abandoned.importID, state: 'abandoned' });
      await expect(createMessageQueueImport({ requestID: 'protocol-3', kind: 'late', clientID: 'bad-client', snapshotHash: 'd'.repeat(64), itemCount: 0, protocol: 3 as 4, expectedGeneration: resumed.generation })).rejects.toMatchObject({ status: 400, code: 'validation_error' });
    } finally { await f.close(); }
  }, 15_000);

  it('经真实 HTTP 接纳 canonical Paste Composer sidecar', async () => {
    const f = await fixture(); const client = new QueryClient(); const ui = surface(client, 'device-a');
    try {
      const content = 'https://trace.example.com/project/demo-project/users/1\n{"input":{"toolName":"controlAC"}}';
      const display = '[Pasted text 1]';
      await expect(ui.admit({
        requestID: 'paste-admission',
        scope: { directory: '/repo', sessionID: 'paste-session' },
        item: {
          queueItemID: 'paste-item', operationID: 'paste-operation', messageID: 'msg_paste', content,
          composerDocument: { text: display, references: [{ id: 'paste-1', kind: 'paste', display, start: 0, end: display.length, text: content, characterCount: Array.from(content).length, index: 1 }] },
          sendConfig: { providerID: 'openai', modelID: 'gpt' }, attachmentIssues: [], createdAt: Date.now(),
        },
      })).resolves.toMatchObject({ status: 'committed' });
      expect(ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'paste-session' })?.items).toEqual([
        expect.objectContaining({ queueItemID: 'paste-item', content, composerDocument: expect.objectContaining({ text: display }) }),
      ]);
    } finally { await f.close(); }
  }, 15_000);

  it('以真实 HTTP 分页保留完整 scope，并由成功 empty catalog 清理', async () => {
    let fail = false; const f = await fixture({ failScopePage: () => fail }); const client = new QueryClient(); const ui = surface(client, 'device-a');
    try {
      for (let index = 0; index < 9; index++) f.service.admit(admission(`page-${index}`));
      await ui.refresh(); const descriptor = [...ui.getState().scopes.values()][0]!;
      expect(ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })?.items).toHaveLength(9);
      fail = true; await ui.refresh();
      expect(readMessageQueueScope(client, descriptor.scopeID, descriptor.revision, 'device-a')?.items).toHaveLength(9);
      while (f.service.getScope(descriptor.scopeID).items.length) { const scope = f.service.getScope(descriptor.scopeID); const current = scope.items[0]!; f.service.remove({ requestID: `remove-${current.queueItemID}`, queueItemID: current.queueItemID, expectedRevision: scope.revision, expectedRowVersion: current.rowVersion }); }
      fail = false; await ui.refresh();
      expect(ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })?.items).toHaveLength(0);
      expect(readMessageQueueScope(client, descriptor.scopeID, f.service.getScope(descriptor.scopeID).revision, 'device-a')?.items).toHaveLength(0);
    } finally { ui.stop(); await f.close(); }
  }, 15_000);

  it('两个真实 surface 经 tip/snapshot 收敛，并以 CAS 刷新重试 edit、reorder、remove、manual send', async () => {
    const f = await fixture(); const aClient = new QueryClient(), bClient = new QueryClient(); const a = surface(aClient, 'device-a'), b = surface(bClient, 'device-b');
    try {
      a.start(); b.start(); await eventually(() => expect(a.getState().hydration).toBe('ready'));
      await a.admit(admission('one')); await a.admit(admission('two'));
      await eventually(() => expect(b.getScope({ transportIdentity: 'device-b', directory: '/repo', sessionID: 'session' })?.items).toHaveLength(2));
      let scope = a.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!;
      const stale = scope; f.service.edit({ requestID: 'external-edit', queueItemID: scope.items[0]!.queueItemID, expectedRevision: scope.revision, expectedRowVersion: scope.items[0]!.rowVersion, item: { content: 'server-race' } });
      await expect(a.edit({ requestID: 'ui-edit', scopeID: stale.scopeID, revision: stale.revision, item: stale.items[0]!, patch: { content: 'edited' } })).resolves.toMatchObject({ status: 'committed' });
      scope = a.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!;
      await a.reorder({ requestID: 'ui-reorder', scopeID: scope.scopeID, revision: scope.revision, queueItemIDs: scope.items.map((row: any) => row.queueItemID).reverse() });
      scope = a.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!;
      await a.remove({ requestID: 'ui-remove', scopeID: scope.scopeID, revision: scope.revision, item: scope.items[0]! });
      f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await a.refresh(); scope = a.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!;
      await a.manualSend({ requestID: 'ui-send', scopeID: scope.scopeID, revision: scope.revision, item: scope.items[0]! });
      await eventually(() => expect(b.getScope({ transportIdentity: 'device-b', directory: '/repo', sessionID: 'session' })?.items).toHaveLength(1));
    } finally { a.stop(); b.stop(); await f.close(); }
  }, 15_000);

  it('paused authority 经真实 HTTP promotion tail，resume 后由 worker 先发送 promoted tail', async () => {
    const sent: string[] = []; const f = await fixture({ send: async (context) => { sent.push(context.queueItemID); return { ok: true }; } }); const client = new QueryClient(); const ui = surface(client, 'device-a');
    try {
      const head = f.service.admit(admission('paused-head')), tail = f.service.admit(admission('paused-tail'));
      const active = f.service.setAuthority({ authority: 'active', expectedGeneration: 0 });
      await ui.refresh(); await ui.pause!(active.generation);
      const scope = ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!;
      const tailItem = scope.items.find((entry: any) => entry.queueItemID === tail.queueItemID)!;
      await expect(ui.manualSend({ requestID: 'paused-send-tail', scopeID: scope.scopeID, revision: scope.revision, item: tailItem })).resolves.toMatchObject({ status: 'committed' });
      expect(ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })?.items.map((entry: any) => entry.queueItemID)).toEqual([tail.queueItemID, head.queueItemID]);
      expect(f.runtime.worker.status().paused).toBe(true); expect(sent).toEqual([]);
      await ui.resume!(active.generation + 1);
      await eventually(() => expect(sent[0]).toBe(tail.queueItemID));
    } finally { ui.stop(); await f.close(); }
  }, 15_000);

  it('上传期间 runtime 切换返回 stale，admission consumption 保留捕获外新增资源', async () => {
    const f = await fixture(); const client = new QueryClient(); let generation = 1; const ui = createMessageQueueServerRuntime({ client, capture: () => ({ transportIdentity: 'device-a', generation }), current: (capture) => capture.transportIdentity === 'device-a' && capture.generation === generation });
    try {
      const capture = createServerQueueAdmissionCapture({ draftKey: { transportIdentity: 'device-a', owner: { kind: 'session', ownerID: 'session' } }, draftRecord: undefined, runtime: { transportIdentity: 'device-a', generation: 1 }, document: { text: 'captured', references: [] }, attachments: [{ id: 'captured', file: new File(['a'], 'a.txt'), dataUrl: '', mimeType: 'text/plain', filename: 'a.txt', size: 1, source: 'local' } as any], inlineDrafts: [] });
      let body = 'captured', attachments = ['captured'], removed: string[] = [];
      const pending = admitServerQueueMessageAndConsumeResources({ capture, admit: async () => { generation = 2; return await ui.admit(admission('stale')) as any; }, captureRuntime: () => ({ transportIdentity: 'device-a', generation }), getCurrentDraftKey: () => capture.draftKey, getDraft: () => undefined, getDocument: () => ({ text: body, references: [] }), consumeBody: () => { body = ''; }, getAttachments: () => attachments.map((id) => ({ id, file: new File(['a'], `${id}.txt`), dataUrl: '', mimeType: 'text/plain', filename: `${id}.txt`, size: 1, source: 'local' } as any)), removeAttachment: (id) => { removed.push(id); attachments = attachments.filter((entry) => entry !== id); }, getInlineDrafts: () => [], removeInlineDraft: () => {} });
      const result = await pending; expect(result).toMatchObject({ status: 'stale', bodyConsumed: false, attachmentIDsConsumed: [] }); expect(body).toBe('captured'); expect(attachments).toEqual(['captured']); expect(removed).toEqual([]);
    } finally { await f.close(); }
  }, 15_000);

  it('真实 edit bridge 下载 Blob、保留 reservation heartbeat，并通过 reserved remove 删除', async () => {
    const f = await fixture(); const client = new QueryClient(); const ui = surface(client, 'device-a');
    try {
      const serverPath = path.join(f.root, 'proof.bin'); fs.writeFileSync(serverPath, 'proof'); const queued = admission('bridge', f.root);
      await ui.admit({ requestID: queued.requestID, scope: queued.scope, item: queued.item, attachments: [{ attachmentID: 'proof', occurrenceRefID: ['root', 'proof'], filename: 'proof.bin', mimeType: 'application/octet-stream', source: 'server', path: serverPath, size: 5 }] });
      await ui.refresh();
      expect(f.service.snapshot().scopes).toHaveLength(1);
      expect(ui.getState().error).toBeUndefined();
      expect(ui.getState().scopes.size).toBe(1);
      const scope = ui.getScope({ transportIdentity: 'device-a', directory: f.root, sessionID: 'session' })!; const committed: any[] = [];
      expect(scope.items[0]!.attachments).toMatchObject([{ size: 5, mimeType: 'application/octet-stream' }]);
      await expect(downloadMessageQueueAttachment(scope.items[0]!.queueItemID, scope.items[0]!.attachments![0]!)).resolves.toMatchObject({ size: 5, type: 'application/octet-stream' });
      const bridge = createMessageQueueServerEditBridge({ queue: ui, current: () => true, input: { captureDraftRuntime: () => ({ transportIdentity: 'device-a', generation: 1 }), commitDraftSnapshot: async (value: any) => { committed.push(value); return { durable: true, current: true, status: 'committed' }; } } as any });
      const result = await bridge.editServerQueueItemIntoDraft({ scopeID: scope.scopeID, scopeRevision: scope.revision, item: scope.items[0]!, targetKey: { transportIdentity: 'device-a', owner: { kind: 'session', ownerID: 'session' } }, expectedRevision: 0 });
      expect(result.diagnostics).toEqual([]); expect(result).toMatchObject({ status: 'committed', queueDurablyRemoved: true });
      expect(await committed[0].values.get('["root","proof"]').text()).toBe('proof'); expect(f.service.getScope(scope.scopeID).items).toHaveLength(0);
    } finally { await f.close(); }
  }, 15_000);
});
