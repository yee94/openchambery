import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageQueueRuntime as createShadowRuntime } from '../../../../ui/src/sync/message-queue-runtime';
import { createMessageQueueRuntimeController } from '../../../../ui/src/sync/message-queue-runtime-controller';
import { createQueueAttachmentCoordinator } from '../../../../ui/src/sync/queue-attachment-coordinator';
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from '../../../../ui/src/sync/input-draft-blob-store';
import { createMessageQueueShadowImporter } from '../../../../ui/src/sync/message-queue-shadow-import';
import { createMessageQueueServerRuntime } from '../../../../ui/src/sync/message-queue-server-runtime';
import { createServerQueueAdmissionCapture, admitServerQueueMessageAndConsumeResources } from '../../../../ui/src/components/chat/queueAdmission';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url';
import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const roots = new Set<string>();
const uiRequire = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const { QueryClient } = uiRequire('@tanstack/react-query') as { QueryClient: new () => any };
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (assertion: () => unknown | Promise<unknown>, timeout = 4_000) => {
  let failure: unknown;
  for (const until = Date.now() + timeout; Date.now() < until; await wait()) { try { return await assertion(); } catch (error) { failure = error; } }
  throw failure;
};
const admission = (id: string, directory = '/repo', sessionID = 'session') => ({ requestID: `request-${id}`, scope: { directory, sessionID }, item: { queueItemID: `item-${id}`, operationID: `operation-${id}`, messageID: `msg_${id}`, content: `body-${id}`, composerDocument: { text: `body-${id}`, references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' }, attachments: [], attachmentIssues: [], createdAt: Date.now() } });

const fixture = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ui-shadow-')); roots.add(root);
  const runtime = createMessageQueueRuntime({ dbPath: path.join(root, 'queue.sqlite'), attachmentRoot: path.join(root, 'attachments'), workerID: `shadow-${process.pid}`, getRuntimeConfig: () => ({ apiBaseUrl: 'runtime' }), isServerPathAllowed: () => true, adapter: { captureRuntime: () => ({}), checkEligibility: async () => ({ idle: true, settled: true, latestMessageID: 'msg_0000000000' }), createMessageID: () => 'msg_0000000001', materializeAttachments: async () => [], send: async () => ({ ok: true }), findMessage: async () => ({ found: false }) } })!;
  await runtime.startPaused();
  const app: any = express(); app.use(express.json()); registerMessageQueueRoutes(app, { messageQueueService: runtime.service, messageQueueRuntime: runtime });
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const resolver = getRuntimeUrlResolver(); setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: base }));
  const close = async () => { await runtime.stop(); server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); setRuntimeUrlResolver(resolver); };
  return { root, runtime, service: runtime.service, base, close };
};

afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe('UI shadow runtime HTTP integration', () => {
  it('真实 shadow importer 将内存 v4 全状态、Blob 与 serverPath 幂等注入 SQLite catalog', async () => {
    const f = await fixture();
    try {
      const serverPath = path.join(f.root, 'server.txt'); fs.writeFileSync(serverPath, 'server');
      const statuses = ['queued', 'retrying', 'reconciling', 'failed', 'unresolved'] as const;
      const items: any[] = statuses.map((status, index) => ({ version: 1, queueItemID: `shadow-${status}`, operationID: `shadow-op-${status}`, messageID: `shadow-msg-${status}`, owner: { state: 'bound', transportIdentity: 'device-a', directory: f.root, sessionID: 'session' }, content: status, composerDocument: { text: status, references: [] }, attachments: index === 0 ? [{ version: 1, attachmentID: 'blob', occurrenceRefID: '["root","blob"]', filename: 'blob.txt', mimeType: 'text/plain', size: 4, source: 'local', locator: { kind: 'blob', blobID: 'blob' } }, { version: 1, attachmentID: 'path', occurrenceRefID: '["root","path"]', filename: 'server.txt', mimeType: 'text/plain', size: 6, source: 'server', serverPath, locator: { kind: 'blob', blobID: 'path' } }] : [], attachmentIssues: [], createdAt: index + 1, status, attemptCount: 1, ...(status === 'retrying' ? { nextAttemptAt: 2, failureKind: 'pre-dispatch' } : {}), ...(status === 'reconciling' || status === 'unresolved' ? { reconciliationStartedAt: 1, reconciliationDeadlineAt: 10, reconciliationChecks: 0, reconciliationNextCheckAt: 2, failureKind: 'ambiguous-dispatch' } : {}), ...(status === 'failed' ? { failureKind: 'definitive' } : {}) }));
      const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver());
      const controller = createMessageQueueRuntimeController(createQueueAttachmentCoordinator(blobs, { persist: async () => ({ ok: true as const, value: undefined }), flush: async () => {}, setEnabled: async () => {}, cancelPending: () => {} }), () => ({ transportIdentity: 'device-a', generation: 1, isCurrent: () => true }));
      const shadow = createShadowRuntime(() => ({ controller, migrate: async () => ({ status: 'committed' as const, snapshot: { version: 4 as const, queues: { [`bound:${JSON.stringify(['device-a', f.root, 'session'])}`]: items }, migration: { v3State: 'complete' as const } } }) }));
      await blobs.putAndRetain({ transportIdentity: 'device-a', owner: { kind: 'queue', ownerID: 'shadow-queued' }, attachmentOccurrenceRefID: '["root","blob"]' }, 'blob', new Blob(['blob'], { type: 'text/plain' }));
      await blobs.putAndRetain({ transportIdentity: 'device-a', owner: { kind: 'queue', ownerID: 'shadow-queued' }, attachmentOccurrenceRefID: '["root","path"]' }, 'path', new Blob(['server'], { type: 'text/plain' }));
      const importer = createMessageQueueShadowImporter({ queue: shadow, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, admit: async (input: any) => { const { signal: _signal, ...body } = input; const response = await fetch(`${f.base}/api/openchamber/message-queue/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error('admit-rejected'); return response.json(); }, existing: () => f.service.snapshot().scopes.flatMap((scope: any) => f.service.getScope(scope.scopeID).items), refresh: async () => {}, publish: () => {} });
      const first = await importer.run(), second = await importer.run();
      expect(first).toMatchObject({ status: 'complete', imported: 5, canActivate: true }); expect(second).toMatchObject({ status: 'complete', imported: 5, canActivate: true });
      const imported = f.service.snapshot().scopes.flatMap((scope: any) => f.service.getScope(scope.scopeID).items);
      expect(imported.map((entry: any) => entry.status).sort()).toEqual(['failed', 'queued', 'reconciling', 'retrying', 'unresolved']); expect(imported.find((entry: any) => entry.queueItemID === 'shadow-queued').attachments).toHaveLength(2);
      expect(f.service.snapshot().scopes.flatMap((scope: any) => f.service.getScope(scope.scopeID).items)).toHaveLength(5);
    } finally { await f.close(); }
  }, 15_000);

  it('A→B 直接 capture、restart 与 A 旧 mutation 完成保持 transport 隔离', async () => {
    const f = await fixture(); const client = new QueryClient(); let identity = 'A', generation = 1;
    const ui = createMessageQueueServerRuntime({ client, capture: () => ({ transportIdentity: identity, generation }), current: (capture) => capture.transportIdentity === identity && capture.generation === generation });
    try {
      f.service.admit(admission('switch')); ui.start(); await eventually(() => expect(ui.getState().hydration).toBe('ready'));
      const scope = ui.getScope({ transportIdentity: 'A', directory: '/repo', sessionID: 'session' })!;
      const pending = ui.edit({ requestID: 'switch-edit', scopeID: scope.scopeID, revision: scope.revision, item: scope.items[0]!, patch: { content: 'edited' } });
      identity = 'B'; generation++;
      expect(ui.getScope({ transportIdentity: 'B', directory: '/repo', sessionID: 'session' })).toBeUndefined();
      expect(await pending.catch(() => ({ status: 'stale' }))).toMatchObject({ status: 'stale' });
      ui.restart();
      await eventually(() => expect(ui.getScope({ transportIdentity: 'B', directory: '/repo', sessionID: 'session' })?.items).toHaveLength(1));
    } finally { ui.stop(); await f.close(); }
  }, 15_000);

  it('admission 等待时只消费 capture 中保持不变的资源', async () => {
    const f = await fixture(); const client = new QueryClient(); const ui = createMessageQueueServerRuntime({ client, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true });
    try {
      const file = (id: string) => ({ id, file: new File([id], `${id}.txt`), dataUrl: '', mimeType: 'text/plain', filename: `${id}.txt`, size: id.length, source: 'local' } as any);
      const captured = file('captured');
      const capture = createServerQueueAdmissionCapture({ draftKey: { transportIdentity: 'device-a', owner: { kind: 'session', ownerID: 'session' } }, draftRecord: undefined, runtime: { transportIdentity: 'device-a', generation: 1 }, document: { text: 'captured', references: [] }, attachments: [captured], inlineDrafts: [{ id: 'inline', text: 'captured' } as any] });
      let body = 'changed', attachments = [captured, file('new')], drafts: any[] = [{ id: 'inline', text: 'changed' }, { id: 'new-inline', text: 'new' }], removed: string[] = [];
      const result = await admitServerQueueMessageAndConsumeResources({ capture, admit: async () => { await ui.admit(admission('capture')); return { status: 'committed' }; }, captureRuntime: () => ({ transportIdentity: 'device-a', generation: 1 }), getCurrentDraftKey: () => capture.draftKey, getDraft: () => undefined, getDocument: () => ({ text: body, references: [] }), consumeBody: () => { body = ''; }, getAttachments: () => attachments, removeAttachment: (id) => { removed.push(id); attachments = attachments.filter((entry) => entry.id !== id); return true; }, getInlineDrafts: () => drafts, removeInlineDraft: (id) => { removed.push(id); drafts = drafts.filter((entry) => entry.id !== id); } });
      expect(result).toEqual({ status: 'committed', bodyConsumed: false, attachmentIDsConsumed: ['captured'], inlineDraftIDsConsumed: [] }); expect(attachments.map((entry) => entry.id)).toEqual(['new']); expect(drafts.map((entry) => entry.id)).toEqual(['inline', 'new-inline']); expect(body).toBe('changed');
    } finally { await f.close(); }
  }, 15_000);
});
