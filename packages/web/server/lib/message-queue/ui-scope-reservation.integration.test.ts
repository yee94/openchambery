import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url';
import { downloadMessageQueueAttachment } from '../../../../ui/src/lib/message-queue-server';
import { createMessageQueueServerRuntime } from '../../../../ui/src/sync/message-queue-server-runtime';
import { createMessageQueueServerEditBridge } from '../../../../ui/src/sync/message-queue-server-edit-bridge';
import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const roots = new Set<string>();
const uiRequire = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const { QueryClient } = uiRequire('@tanstack/react-query') as { QueryClient: new () => any };
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (assertion: () => unknown | Promise<unknown>, timeout = 5_000) => {
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

const fixture = async (options: { send?: (context: any) => Promise<any>; beforeRoutes?: (app: any) => void } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ui-reservation-')); roots.add(root);
  const runtimeConfig = { current: { apiBaseUrl: 'runtime-a' } };
  const runtime = createMessageQueueRuntime({
    dbPath: path.join(root, 'queue.sqlite'), attachmentRoot: path.join(root, 'attachments'), workerID: `reservation-${process.pid}`,
    getRuntimeConfig: () => runtimeConfig.current, isServerPathAllowed: () => true,
    adapter: {
      captureRuntime: () => ({ key: runtimeConfig.current.apiBaseUrl }), checkEligibility: async () => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0000000000' }),
      createMessageID: (() => { let id = 0; return () => `msg_${String(++id).padStart(10, '0')}`; })(), materializeAttachments: async () => [],
      send: options.send ?? (async () => ({ ok: true })), findMessage: async () => ({ found: false }),
    },
  })!;
  await runtime.startPaused();
  const app: any = express(); app.use(express.json()); options.beforeRoutes?.(app); registerMessageQueueRoutes(app, { messageQueueService: runtime.service, messageQueueRuntime: runtime });
  const server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const prior = getRuntimeUrlResolver(); setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` }));
  return { root, runtime, service: runtime.service, close: async () => { await runtime.stop(); server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); setRuntimeUrlResolver(prior); } };
};
const surface = (client: any) => createMessageQueueServerRuntime({ client, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: (capture) => capture.transportIdentity === 'device-a' && capture.generation === 1 });

afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe('UI scope dispatch and edit reservation integration', () => {
  it('通过真实 HTTP/UI 覆盖 sending scope 的 waiting tail，同时保持跨 scope 并发与 FIFO', async () => {
    const releases: Array<() => void> = [], sent: string[] = [], messageIDs = new Map<string, string>();
    const f = await fixture({ send: async (context) => { sent.push(context.queueItemID); messageIDs.set(context.queueItemID, context.messageID); await new Promise<void>((resolve) => releases.push(resolve)); return { ok: true }; } });
    const ui = surface(new QueryClient());
    try {
      await ui.admit(admission('a-head')); await ui.admit(admission('a-tail')); await ui.admit(admission('b-head', '/scope-b', 'b'));
      f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await ui.refresh();
      const run = f.runtime.startActive(); await eventually(() => expect(releases).toHaveLength(2));
      const scopeA = ui.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session' })!; const tail = scopeA.items.find((item: any) => item.queueItemID === 'item-a-tail')!;
      await expect(ui.manualSend({ requestID: 'ui-send-tail', scopeID: scopeA.scopeID, revision: scopeA.revision, item: tail })).resolves.toMatchObject({ status: 'committed' });
      await expect(ui.reorder({ requestID: 'ui-reorder-tail', scopeID: scopeA.scopeID, revision: scopeA.revision, queueItemIDs: scopeA.items.map((item: any) => item.queueItemID).reverse() })).resolves.toMatchObject({ status: 'committed' });
      expect(sent).toEqual(expect.arrayContaining(['item-a-head', 'item-b-head'])); expect(sent).not.toContain('item-a-tail');
      releases.splice(0).forEach((release) => release()); f.runtime.worker.confirmByMessage({ directory: '/repo', sessionID: 'session', messageID: messageIDs.get('item-a-head')! }); f.runtime.worker.confirmByMessage({ directory: '/scope-b', sessionID: 'b', messageID: messageIDs.get('item-b-head')! }); await f.runtime.wake(); await eventually(() => expect(sent).toContain('item-a-tail'));
      expect(sent.indexOf('item-a-head')).toBeLessThan(sent.indexOf('item-a-tail')); releases.splice(0).forEach((release) => release()); await run;
    } finally { ui.stop(); await f.close(); }
  }, 15_000);

  it('真实 renew HTTP 在 draft 下载期间维持 reservation，并在失败后中止并让 expiry 恢复 worker', async () => {
    let renews = 0, failRenew = false, posts = 0;
    const f = await fixture({
      send: async () => { posts++; return { ok: true }; },
      beforeRoutes: (app) => app.use((request: any, response: any, next: any) => {
        if (request.path.includes('/edit-reservations/') && request.path.endsWith('/renew')) { renews++; if (failRenew) return response.status(409).json({ code: 'reservation_expired' }); }
        next();
      }),
    });
    const ui = surface(new QueryClient());
    try {
      const serverPath = path.join(f.root, 'proof.bin'); fs.writeFileSync(serverPath, 'proof');
      const add = async (id: string) => ui.admit({ ...admission(id, f.root), attachments: [{ attachmentID: `proof-${id}`, occurrenceRefID: ['root', `proof-${id}`], filename: 'proof.bin', mimeType: 'application/octet-stream', source: 'server', path: serverPath, size: 5 }] });
      await add('renew-ok'); f.service.setAuthority({ authority: 'active', expectedGeneration: 0 }); await ui.refresh();
      let releaseDownload!: () => void; const delayedDownload = async (...args: Parameters<typeof downloadMessageQueueAttachment>) => { await new Promise<void>((resolve) => { releaseDownload = resolve; }); return downloadMessageQueueAttachment(...args); };
      const commits: any[] = [];
      const bridge = createMessageQueueServerEditBridge({ queue: ui, download: delayedDownload, current: () => true, input: { captureDraftRuntime: () => ({ transportIdentity: 'device-a', generation: 1 }), commitDraftSnapshot: async (value: any) => { commits.push(value); return { durable: true, current: true, status: 'committed' }; } } as any });
      const firstScope = ui.getScope({ transportIdentity: 'device-a', directory: f.root, sessionID: 'session' })!;
      const first = bridge.editServerQueueItemIntoDraft({ scopeID: firstScope.scopeID, scopeRevision: firstScope.revision, item: firstScope.items[0]!, targetKey: { transportIdentity: 'device-a', owner: { kind: 'session', ownerID: 'session' } }, expectedRevision: 0 });
      await eventually(() => expect(f.service.getScope(firstScope.scopeID).items[0]!.status).toBe('queued'));
      await wait(43_000); expect(renews).toBeGreaterThanOrEqual(2); await Promise.all([f.runtime.wake(), f.runtime.wake(), f.runtime.wake()]); expect(posts).toBe(0);
      releaseDownload(); await expect(first).resolves.toMatchObject({ status: 'committed', queueDurablyRemoved: true }); expect(commits).toHaveLength(1);

      await add('renew-fail'); await ui.refresh(); const secondScope = ui.getScope({ transportIdentity: 'device-a', directory: f.root, sessionID: 'session' })!; const secondItem = secondScope.items[0]!;
      let releaseFailedDownload!: () => void; const stuckDownload = async (...args: Parameters<typeof downloadMessageQueueAttachment>) => { await new Promise<void>((resolve) => { releaseFailedDownload = resolve; }); return downloadMessageQueueAttachment(...args); };
      failRenew = true; const failing = createMessageQueueServerEditBridge({ queue: ui, download: stuckDownload, current: () => true, input: { captureDraftRuntime: () => ({ transportIdentity: 'device-a', generation: 1 }), commitDraftSnapshot: async () => { commits.push('failed'); return { durable: true, current: true, status: 'committed' }; } } as any });
      const failed = failing.editServerQueueItemIntoDraft({ scopeID: secondScope.scopeID, scopeRevision: secondScope.revision, item: secondItem, targetKey: { transportIdentity: 'device-a', owner: { kind: 'session', ownerID: 'session' } }, expectedRevision: 0 });
      await wait(20_100); void f.runtime.startActive(); releaseFailedDownload(); await expect(failed).resolves.toMatchObject({ status: 'materialize-failed', diagnostics: [{ code: 'lease-lost' }] }); expect(commits).toHaveLength(1); expect(f.service.getScope(secondScope.scopeID).items).toHaveLength(1);
      await wait(40_100); await f.runtime.wake(); await eventually(() => expect(posts).toBe(1));
    } finally { ui.stop(); await f.close(); }
  }, 125_000);
});
