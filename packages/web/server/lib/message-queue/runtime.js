import path from 'node:path';
import { createAttachmentStore } from './attachment-store.js';
import { createOpenCodeMessageQueueAdapter } from './opencode-adapter.js';
import { createMessageQueueService } from './service.js';
import { createMessageQueueWorker } from './worker.js';

export const createMessageQueueRuntime = ({ dbPath, attachmentRoot, service, attachmentStore, adapter, worker, getOpenCodeRuntimeConfig, onRevisionTip = null, ...dependencies } = {}) => {
  const queue = service ?? createMessageQueueService({ dbPath, onRevisionTip, ...dependencies });
  if (!queue) return null;
  const store = attachmentStore ?? createAttachmentStore({ rootDir: attachmentRoot ?? path.join(path.dirname(dbPath), 'message-queue-attachments'), maxBytes: 25 * 1024 * 1024, isServerPathAllowed: dependencies.isServerPathAllowed });
  const openCodeAdapter = adapter ?? createOpenCodeMessageQueueAdapter({ ...dependencies, getRuntimeConfig: getOpenCodeRuntimeConfig ?? (() => null), readAttachment: async (attachment, item, options) => store.readAttachment(attachment, item, options) });
  const queueWorker = worker ?? createMessageQueueWorker({ service: queue, adapter: openCodeAdapter, workerID: dependencies.workerID ?? `queue-${process.pid}` });
  let stopped = false; let gcTimer;
  const gc = async () => { queue.expireAttachmentUploadsAll?.(); const stale = queue.listAttachmentObjectsForGC(); for (const object of stale) { await Promise.resolve(store.deleteObjectIf?.(object.storageKey, () => queue.removeAttachmentObjectForGC?.(object))).catch(() => {}); } await store.gc({ liveStorageKeys: queue.listLiveAttachmentStorageKeys?.() ?? new Set(), isStorageKeyLive: (storageKey) => queue.isAttachmentStorageKeyLive?.(storageKey) ?? false }); };
  const status = () => ({ capability: true, ...queue.getAuthority(), worker: queueWorker.status() });
  const startPaused = async () => { await store.init(); await gc(); if (!gcTimer) gcTimer = setInterval(() => { void gc(); }, 60 * 60 * 1000); return status(); };
  const start = async () => { await startPaused(); const authority = queue.getAuthority(); if (authority.authority === 'active') queueWorker.start(); else await queueWorker.stop(); return status(); };
  const startActive = async () => { await startPaused(); queueWorker.start(); return status(); };
  const wake = () => {
    try {
      // admit / manualSend / session.idle / edit-release wake the loop. If authority
      // became active after a paused boot (or without going through start/resume),
      // wake would otherwise no-op forever while status reports authority:active.
      const authority = queue.getAuthority();
      if (authority?.authority === 'active' && queueWorker.status()?.paused) queueWorker.start();
      return Promise.resolve(queueWorker.wake()).catch((error) => { console.error('message_queue_runtime_wake_failed', error); return status(); });
    }
    catch (error) { console.error('message_queue_runtime_wake_failed', error); return Promise.resolve(status()); }
  };
  const isCurrentRuntimeEvent = (event) => {
    const eventKey = event?.runtimeIdentity?.runtimeKey;
    if (typeof eventKey !== 'string') return false;
    try { return eventKey === queue.getRuntimeKey(); } catch { return false; }
  };
  const observeSessionEvent = (event) => {
    if (!isCurrentRuntimeEvent(event)) return false;
    const payload = event?.payload?.payload ?? event?.payload;
    const properties = payload?.properties;
    const directory = typeof event?.directory === 'string' && event.directory !== 'global' ? event.directory : '';
    const sessionID = typeof properties?.sessionID === 'string' ? properties.sessionID : '';
    if (!directory || !sessionID) return false;
    const phase = payload.type === 'session.status'
      ? properties?.status?.type ?? properties?.info?.type
      : payload.type === 'session.idle' ? 'idle' : payload.type === 'session.error' ? 'error' : '';
    if (typeof phase !== 'string' || !phase) return false;
    openCodeAdapter.observeSessionEvent?.({ directory, sessionID }, phase);
    return true;
  };
  const noteClientOperation = (scope) => {
    if (typeof scope?.directory !== 'string' || !scope.directory || typeof scope?.sessionID !== 'string' || !scope.sessionID) return false;
    openCodeAdapter.noteClientOperation?.(scope);
    return true;
  };
  const stop = async () => { if (stopped) return; stopped = true; clearInterval(gcTimer); await queueWorker.stop(); await gc(); await store.stop(); queue.close(); };
  return { service: queue, attachmentStore: store, adapter: openCodeAdapter, worker: queueWorker, setAssistantDeliveryService: (assistantService) => queue.setAssistantDeliveryService?.(assistantService), status, start, startPaused, startActive, wake, observeSessionEvent, noteClientOperation, stop };
};
