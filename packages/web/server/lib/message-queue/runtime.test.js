import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/sdk/v2', () => ({ createOpencodeClient: vi.fn() }));
const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
import { createMessageQueueRuntime } from './runtime.js';

describe('message queue runtime ownership', () => {
  it('keeps the durable queue identity separate from the upstream OpenCode adapter URL', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-queue-runtime-'));
    const uiUrl = 'http://127.0.0.1:57123'; const upstreamUrl = 'http://127.0.0.1:4096/';
    const status = vi.fn(() => ({ data: {} })); const messages = vi.fn(() => ({ data: [] }));
    createOpencodeClient.mockReturnValue({ session: { status, messages, promptAsync: vi.fn() } });
    const runtime = createMessageQueueRuntime({ dbPath: path.join(root, 'queue.sqlite'), getRuntimeConfig: () => ({ apiBaseUrl: uiUrl }), getOpenCodeRuntimeConfig: () => ({ apiBaseUrl: upstreamUrl }), buildOpenCodeUrl: () => upstreamUrl, getOpenCodeAuthHeaders: () => ({}) });
    try {
      const adapterRuntime = runtime.adapter.captureRuntime();
      await runtime.adapter.checkEligibility({ directory: '/repo', sessionID: 'session' }, adapterRuntime);
      expect(runtime.service.getRuntimeKey()).toBe(crypto.createHash('sha256').update(`url:${uiUrl}`).digest('hex'));
      expect(adapterRuntime.config.apiBaseUrl).toBe(upstreamUrl);
      expect(createOpencodeClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:4096' }));
      expect(createOpencodeClient.mock.calls.map(([options]) => options.baseUrl)).not.toContain(uiUrl);
    } finally {
      await runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('CAS-deletes orphan metadata before its file and passes live keys to store GC', async () => {
    const order = [];
    const service = {
      expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => [{ objectHash: 'hash', storageKey: 'key' }]), listLiveAttachmentStorageKeys: vi.fn(() => new Set(['live-key'])),
      removeAttachmentObjectForGC: vi.fn(() => { order.push('metadata'); return 1; }), getAuthority: vi.fn(() => ({ authority: 'paused', generation: 0 })), close: vi.fn(() => order.push('db')),
    };
    const store = { init: vi.fn(), deleteObjectIf: vi.fn(async (_key, predicate) => { if (predicate() === 1) order.push('file'); }), gc: vi.fn(), stop: vi.fn(async () => order.push('store')) };
    const worker = { status: () => ({ paused: true, active: 0 }), stop: vi.fn(async () => { order.push('worker'); }) };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await runtime.startPaused();
    expect(order).toEqual(['metadata', 'file']);
    expect(store.gc).toHaveBeenCalledWith(expect.objectContaining({ liveStorageKeys: new Set(['live-key']), isStorageKeyLive: expect.any(Function) }));
    await runtime.stop();
    expect(order).toEqual(['metadata', 'file', 'worker', 'metadata', 'file', 'store', 'db']);
  });

  it('preserves a file when a concurrent admission makes the metadata CAS return zero', async () => {
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => [{ objectHash: 'hash', storageKey: 'key' }]), listLiveAttachmentStorageKeys: vi.fn(() => new Set(['key'])), removeAttachmentObjectForGC: vi.fn(() => 0), getAuthority: vi.fn(() => ({ authority: 'paused', generation: 0 })), close: vi.fn() };
    const store = { init: vi.fn(), deleteObjectIf: vi.fn(), gc: vi.fn(), stop: vi.fn() };
    const worker = { status: () => ({ paused: true, active: 0 }), stop: vi.fn() };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await runtime.startPaused();
    expect(store.deleteObjectIf).toHaveBeenCalledTimes(1);
    expect(store.gc).toHaveBeenCalledWith(expect.objectContaining({ liveStorageKeys: new Set(['key']), isStorageKeyLive: expect.any(Function) }));
  });

  it('leaves an orphan file for filesystem GC after metadata CAS succeeds and file deletion fails', async () => {
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => [{ objectHash: 'hash', storageKey: 'key' }]), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), removeAttachmentObjectForGC: vi.fn(() => 1), getAuthority: vi.fn(() => ({ authority: 'paused', generation: 0 })), close: vi.fn() };
    const store = { init: vi.fn(), deleteObjectIf: vi.fn(async (_key, predicate) => { predicate(); throw new Error('disk'); }), gc: vi.fn(), stop: vi.fn() };
    const worker = { status: () => ({ paused: true, active: 0 }), stop: vi.fn() };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await runtime.startPaused();
    expect(service.removeAttachmentObjectForGC).toHaveBeenCalledTimes(1);
    expect(store.gc).toHaveBeenCalledWith(expect.objectContaining({ liveStorageKeys: new Set(), isStorageKeyLive: expect.any(Function) }));
  });

  it('waits for an abort-ignoring active worker before closing store and database', async () => {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const order = [];
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => []), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), getAuthority: vi.fn(() => ({ authority: 'paused', generation: 0 })), close: vi.fn(() => order.push('db')) };
    const store = { init: vi.fn(), gc: vi.fn(), deleteObject: vi.fn(), stop: vi.fn(async () => order.push('store')) };
    const worker = { status: () => ({ paused: false, active: 1 }), stop: vi.fn(async () => { await pending; order.push('worker'); }) };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(order).toEqual([]);
    settle();
    await stopping;
    expect(order).toEqual(['worker', 'store', 'db']);
  });

  it('returns active startup status while worker dispatch continues in the background', async () => {
    const pending = new Promise(() => {});
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => []), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), getAuthority: vi.fn(() => ({ authority: 'active', generation: 1 })), close: vi.fn() };
    const store = { init: vi.fn(), gc: vi.fn(), deleteObjectIf: vi.fn(), stop: vi.fn() };
    const worker = { status: () => ({ paused: false, active: 1 }), start: vi.fn(() => pending), stop: vi.fn() };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await expect(runtime.start()).resolves.toMatchObject({ worker: { active: 1 } });
    expect(worker.start).toHaveBeenCalledTimes(1);
  });

  it('settles a rejected fire-and-forget worker wake with a runtime diagnostic', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => []), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), getAuthority: vi.fn(() => ({ authority: 'active', generation: 1 })), close: vi.fn() };
    const store = { init: vi.fn(), gc: vi.fn(), deleteObjectIf: vi.fn(), stop: vi.fn() };
    const worker = { status: () => ({ paused: false, active: 0 }), wake: vi.fn(() => Promise.reject(new Error('event wake failed'))), stop: vi.fn() };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await expect(runtime.wake()).resolves.toMatchObject({ worker: { active: 0 } });
    expect(diagnostic).toHaveBeenCalledWith('message_queue_runtime_wake_failed', expect.objectContaining({ message: 'event wake failed' }));
    diagnostic.mockRestore();
  });

  it('starts a paused worker on wake when authority is already active', async () => {
    let paused = true;
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => []), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), getAuthority: vi.fn(() => ({ authority: 'active', generation: 1 })), close: vi.fn() };
    const store = { init: vi.fn(), gc: vi.fn(), deleteObjectIf: vi.fn(), stop: vi.fn() };
    const worker = {
      status: () => ({ paused, active: 0 }),
      start: vi.fn(() => { paused = false; return { paused, active: 0 }; }),
      wake: vi.fn(() => Promise.resolve({ paused, active: 0 })),
      stop: vi.fn(),
    };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await expect(runtime.wake()).resolves.toMatchObject({ paused: false, active: 0 });
    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(worker.wake).toHaveBeenCalledTimes(1);
  });

  it('does not start a paused worker on wake when authority is not active', async () => {
    const service = { expireAttachmentUploadsAll: vi.fn(), listAttachmentObjectsForGC: vi.fn(() => []), listLiveAttachmentStorageKeys: vi.fn(() => new Set()), getAuthority: vi.fn(() => ({ authority: 'shadow', generation: 0 })), close: vi.fn() };
    const store = { init: vi.fn(), gc: vi.fn(), deleteObjectIf: vi.fn(), stop: vi.fn() };
    const worker = { status: () => ({ paused: true, active: 0 }), start: vi.fn(), wake: vi.fn(() => Promise.resolve({ paused: true, active: 0 })), stop: vi.fn() };
    const runtime = createMessageQueueRuntime({ dbPath: '/tmp/queue.sqlite', service, attachmentStore: store, worker, adapter: {} });
    await expect(runtime.wake()).resolves.toMatchObject({ paused: true, active: 0 });
    expect(worker.start).not.toHaveBeenCalled();
    expect(worker.wake).toHaveBeenCalledTimes(1);
  });
});
