/**
 * Independent assistant-attachment cache lane (UI lib only).
 *
 * Cache key: transport + durable auth scope + assistantID + attachmentID + sha256
 * - Bearer → SHA-256(bearer) durable IDB partition (no plaintext secrets)
 * - Cookie-only → memory-ephemeral keyed by authGeneration
 * - Runtime switch: drop memory/display/inflight only; keep IDB partitions
 * - Auth revoke / forget / 401: clear captured scope only (epoch-fenced)
 */
import {
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  digestSha256Hex,
  isAssistantAttachmentDescriptor,
  type AssistantAttachmentDescriptor,
} from '@/lib/assistant-attachment-upload';
import { DualLimitLru } from '@/lib/dualLimitLru';
import {
  isRelayImageDisplayUrlLive,
  releaseRelayImageDisplayRetain,
  releaseRelayImageDisplayUrl,
  retainRelayImageDisplayUrl,
  RELAY_IMAGE_MAX_BYTES,
  streamVerifiedBlobDisplayUrl,
} from '@/lib/relay/relay-image-stream';
import {
  getRuntimeAuthGeneration,
  getRuntimeBearerTokenSync,
  invalidateRuntimeAuthSession,
  subscribeRuntimeAuthGeneration,
  type RuntimeAuthGenerationDetail,
} from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export const ASSISTANT_ATTACHMENT_CACHE_MAX_BYTES = 100 * 1024 * 1024;
export const ASSISTANT_ATTACHMENT_CACHE_MAX_ENTRIES = 200;
/** Display/download bound for legacy descriptors (native ceiling); upload stays 25 MiB. */
export const ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES = RELAY_IMAGE_MAX_BYTES;

const IDB_NAME = 'openchamber-assistant-attachments';
const IDB_VERSION = 2;
const IDB_META = 'meta';
const IDB_DATA = 'data';

export type AssistantAttachmentAuthScopeKind = 'bearer-hash' | 'memory-ephemeral';

export type AssistantAttachmentCacheScope = {
  transportIdentity: string;
  authScope: string;
  authScopeKind: AssistantAttachmentAuthScopeKind;
  authGeneration: number;
};

export class AssistantAttachmentCacheError extends Error {
  readonly status: number;
  readonly code: 'unavailable' | 'too-large' | 'rejected' | 'integrity' | 'aborted' | 'unauthorized' | 'stale';

  constructor(
    status: number,
    code: AssistantAttachmentCacheError['code'],
    message = 'Assistant attachment cache error',
  ) {
    super(message);
    this.name = 'AssistantAttachmentCacheError';
    this.status = status;
    this.code = code;
  }
}

type CacheEntry = {
  blob: Blob;
  sha256: string;
  size: number;
  mime: string;
  lastAccess: number;
};

type InflightDownload = {
  promise: Promise<Blob>;
  controller: AbortController;
  subscribers: number;
  scope: AssistantAttachmentCacheScope;
  epoch: number;
};

type DisplayLease = {
  url: string;
  refs: number;
  cacheKey: string;
  epoch: number;
};

type DisplayInflight = {
  promise: Promise<string>;
  controller: AbortController;
  subscribers: number;
  epoch: number;
  /** Set when materialization resolves; released if all subscribers leave first. */
  url: string | null;
  releasedOrphan: boolean;
};

type IdbMeta = {
  key: string;
  sha256: string;
  size: number;
  mime: string;
  lastAccess: number;
  transportIdentity: string;
  authScope: string;
};

type IdbData = {
  key: string;
  bytes: ArrayBuffer;
};

const memoryCache = new DualLimitLru<string, CacheEntry>({
  maxEntries: ASSISTANT_ATTACHMENT_CACHE_MAX_ENTRIES,
  maxBytes: ASSISTANT_ATTACHMENT_CACHE_MAX_BYTES,
});

const inflight = new Map<string, InflightDownload>();
const displayLeases = new Map<string, DisplayLease>();
const displayInflight = new Map<string, DisplayInflight>();

let transportUnsubscribe: (() => void) | null = null;
let authUnsubscribe: (() => void) | null = null;
/** Bumps on any scope clear so late awaits cannot write into a new session. */
let cacheEpoch = 0;
let idbPromise: Promise<IDBDatabase | null> | null = null;
let idbDisabled = false;
/** Serial fence for IDB mutate paths (delete/write/evict). */
let idbFence: Promise<void> = Promise.resolve();

const hexFromBuffer = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const hashUtf8 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  return hexFromBuffer(await crypto.subtle.digest('SHA-256', bytes));
};

const withIdbFence = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = idbFence;
  let release!: () => void;
  idbFence = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
  }
};

const bumpEpoch = (): number => {
  cacheEpoch += 1;
  return cacheEpoch;
};

export const getAssistantAttachmentCacheEpoch = (): number => cacheEpoch;

const scopeEquals = (left: AssistantAttachmentCacheScope, right: AssistantAttachmentCacheScope): boolean => (
  left.transportIdentity === right.transportIdentity
  && left.authScope === right.authScope
  && left.authScopeKind === right.authScopeKind
);

const assertEpoch = (epoch: number, scope: AssistantAttachmentCacheScope): void => {
  if (epoch !== cacheEpoch) {
    throw new AssistantAttachmentCacheError(0, 'stale', 'Attachment cache epoch changed');
  }
  // Auth generation may bump without full epoch if we only bump epoch on clears;
  // always re-check current scope identity for bearer/memory keys.
  void scope;
};

export const resolveAssistantAttachmentCacheScope = async (
  options: {
    bearer?: string | null;
    transportIdentity?: string;
    authGeneration?: number;
  } = {},
): Promise<AssistantAttachmentCacheScope> => {
  const transportIdentity = options.transportIdentity ?? getRuntimeTransportIdentity();
  const authGeneration = options.authGeneration ?? getRuntimeAuthGeneration();
  const bearer = (options.bearer ?? getRuntimeBearerTokenSync()).trim();
  if (bearer) {
    const digest = await hashUtf8(bearer);
    return {
      transportIdentity,
      authScope: `b:${digest}`,
      authScopeKind: 'bearer-hash',
      authGeneration,
    };
  }
  return {
    transportIdentity,
    authScope: `m:${authGeneration}`,
    authScopeKind: 'memory-ephemeral',
    authGeneration,
  };
};

export const getAssistantAttachmentCacheCapabilities = async (): Promise<{
  durableIndexedDB: boolean;
  authScopeKind: AssistantAttachmentAuthScopeKind;
  reason: string;
}> => {
  const scope = await resolveAssistantAttachmentCacheScope();
  if (scope.authScopeKind === 'bearer-hash') {
    return {
      durableIndexedDB: true,
      authScopeKind: scope.authScopeKind,
      reason: 'Bearer present; cache key uses SHA-256(bearer) without plaintext.',
    };
  }
  return {
    durableIndexedDB: false,
    authScopeKind: scope.authScopeKind,
    reason:
      'Cookie-only / empty-bearer sessions use process-local authGeneration memory scope; durable isolation requires a bearer.',
  };
};

const buildCacheKey = (
  scope: AssistantAttachmentCacheScope,
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
): string =>
  [
    scope.transportIdentity,
    scope.authScope,
    assistantID.trim(),
    descriptor.attachmentID.trim(),
    descriptor.sha256.toLowerCase(),
  ].join('\u0000');

const touchMemory = (key: string, entry: CacheEntry): CacheEntry => {
  const next = { ...entry, lastAccess: Date.now() };
  memoryCache.set(key, next, next.size);
  return next;
};

const getIndexedDB = (): IDBFactory | null => {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB;
  } catch {
    // ignore
  }
  return null;
};

const openIdb = (): Promise<IDBDatabase | null> => {
  if (idbDisabled) return Promise.resolve(null);
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    const factory = getIndexedDB();
    if (!factory) {
      idbDisabled = true;
      resolve(null);
      return;
    }
    try {
      const request = factory.open(IDB_NAME, IDB_VERSION);
      request.onerror = () => {
        idbDisabled = true;
        idbPromise = null;
        resolve(null);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains('blobs')) {
          db.deleteObjectStore('blobs');
        }
        if (!db.objectStoreNames.contains(IDB_META)) {
          const meta = db.createObjectStore(IDB_META, { keyPath: 'key' });
          meta.createIndex('lastAccess', 'lastAccess');
          meta.createIndex('authScope', 'authScope');
          meta.createIndex('transportIdentity', 'transportIdentity');
        }
        if (!db.objectStoreNames.contains(IDB_DATA)) {
          db.createObjectStore(IDB_DATA, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // ignore
          }
          idbPromise = null;
        };
        resolve(db);
      };
    } catch {
      idbDisabled = true;
      idbPromise = null;
      resolve(null);
    }
  });
  return idbPromise;
};

const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb-request-failed'));
  });

const waitTx = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb-tx-failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb-tx-aborted'));
  });

const idbReadMeta = async (key: string): Promise<IdbMeta | null> => {
  const db = await openIdb();
  if (!db) return null;
  try {
    const tx = db.transaction(IDB_META, 'readonly');
    const row = await idbRequest(tx.objectStore(IDB_META).get(key) as IDBRequest<IdbMeta | undefined>);
    return row ?? null;
  } catch {
    return null;
  }
};

const idbReadData = async (key: string): Promise<IdbData | null> => {
  const db = await openIdb();
  if (!db) return null;
  try {
    const tx = db.transaction(IDB_DATA, 'readonly');
    const row = await idbRequest(tx.objectStore(IDB_DATA).get(key) as IDBRequest<IdbData | undefined>);
    return row ?? null;
  } catch {
    return null;
  }
};

const idbTouchMeta = async (key: string, lastAccess: number): Promise<void> => {
  await withIdbFence(async () => {
    const db = await openIdb();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_META, 'readwrite');
      const store = tx.objectStore(IDB_META);
      const existing = await idbRequest(store.get(key) as IDBRequest<IdbMeta | undefined>);
      if (!existing) return;
      store.put({ ...existing, lastAccess });
      await waitTx(tx);
    } catch {
      // best-effort touch
    }
  });
};

/** Evict via meta cursor only — never getAll() of byte payloads. */
const idbEvictUntil = async (
  db: IDBDatabase,
  options: { maxEntries: number; maxBytes: number; needBytes?: number },
): Promise<void> => {
  const tx = db.transaction([IDB_META, IDB_DATA], 'readwrite');
  const metaStore = tx.objectStore(IDB_META);
  const dataStore = tx.objectStore(IDB_DATA);
  const index = metaStore.index('lastAccess');

  const metas: IdbMeta[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursorReq = index.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('idb-cursor-failed'));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      metas.push(cursor.value as IdbMeta);
      cursor.continue();
    };
  });

  let totalBytes = metas.reduce((sum, row) => sum + (row.size || 0), 0);
  let entries = metas.length;
  const need = Math.max(0, options.needBytes ?? 0);
  const targetBytes = Math.max(0, options.maxBytes - need);

  // Oldest-first (lastAccess ascending via index order).
  for (const row of metas) {
    if (entries <= options.maxEntries && totalBytes <= targetBytes) break;
    metaStore.delete(row.key);
    dataStore.delete(row.key);
    totalBytes -= row.size || 0;
    entries -= 1;
  }
  await waitTx(tx);
};

const idbWrite = async (
  meta: IdbMeta,
  bytes: ArrayBuffer,
  epoch: number,
  scope: AssistantAttachmentCacheScope,
): Promise<boolean> => {
  if (epoch !== cacheEpoch) return false;
  // Refuse writes whose partition no longer matches the live session identity.
  const live = await resolveAssistantAttachmentCacheScope();
  if (epoch !== cacheEpoch) return false;
  if (live.authScope !== scope.authScope || live.transportIdentity !== scope.transportIdentity) {
    return false;
  }

  return withIdbFence(async () => {
    if (epoch !== cacheEpoch) return false;
    const db = await openIdb();
    if (!db) return false;

    const attempt = async (): Promise<boolean> => {
      if (epoch !== cacheEpoch) return false;
      // Free room for this write first (metadata-only eviction).
      await idbEvictUntil(db, {
        maxEntries: ASSISTANT_ATTACHMENT_CACHE_MAX_ENTRIES - 1,
        maxBytes: ASSISTANT_ATTACHMENT_CACHE_MAX_BYTES,
        needBytes: meta.size,
      });
      if (epoch !== cacheEpoch) return false;
      const tx = db.transaction([IDB_META, IDB_DATA], 'readwrite');
      tx.objectStore(IDB_META).put(meta);
      tx.objectStore(IDB_DATA).put({ key: meta.key, bytes });
      await waitTx(tx);
      return true;
    };

    try {
      return await attempt();
    } catch (error) {
      const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
      if (!quota) return false;
      try {
        await idbEvictUntil(db, {
          maxEntries: Math.max(0, ASSISTANT_ATTACHMENT_CACHE_MAX_ENTRIES - 1),
          maxBytes: ASSISTANT_ATTACHMENT_CACHE_MAX_BYTES,
          needBytes: meta.size,
        });
        if (epoch !== cacheEpoch) return false;
        return await attempt();
      } catch {
        return false;
      }
    }
  });
};

const idbDeleteMatching = async (
  predicate: (meta: IdbMeta) => boolean,
): Promise<void> => {
  await withIdbFence(async () => {
    const db = await openIdb();
    if (!db) return;
    try {
      const tx = db.transaction([IDB_META, IDB_DATA], 'readwrite');
      const metaStore = tx.objectStore(IDB_META);
      const dataStore = tx.objectStore(IDB_DATA);
      const allKeys = await idbRequest(metaStore.getAllKeys() as IDBRequest<IDBValidKey[]>);
      for (const key of allKeys) {
        if (typeof key !== 'string') continue;
        const meta = await idbRequest(metaStore.get(key) as IDBRequest<IdbMeta | undefined>);
        if (meta && predicate(meta)) {
          metaStore.delete(key);
          dataStore.delete(key);
        }
      }
      await waitTx(tx);
    } catch {
      // best-effort
    }
  });
};

const remember = async (
  key: string,
  blob: Blob,
  meta: { sha256: string; size: number; mime: string },
  scope: AssistantAttachmentCacheScope,
  epoch: number,
): Promise<void> => {
  if (epoch !== cacheEpoch) return;
  const entry: CacheEntry = {
    blob,
    sha256: meta.sha256,
    size: meta.size,
    mime: meta.mime,
    lastAccess: Date.now(),
  };
  memoryCache.set(key, entry, entry.size);
  if (scope.authScopeKind !== 'bearer-hash') return;
  if (epoch !== cacheEpoch) return;
  const bytes = await blob.arrayBuffer();
  if (epoch !== cacheEpoch) return;
  await idbWrite(
    {
      key,
      sha256: meta.sha256,
      size: meta.size,
      mime: meta.mime,
      lastAccess: entry.lastAccess,
      transportIdentity: scope.transportIdentity,
      authScope: scope.authScope,
    },
    bytes,
    epoch,
    scope,
  );
};

const readCached = async (
  key: string,
  expectedSha: string,
  scope: AssistantAttachmentCacheScope,
  epoch: number,
): Promise<Blob | null> => {
  assertEpoch(epoch, scope);
  const memory = memoryCache.get(key);
  if (memory && memory.sha256 === expectedSha && memory.blob.size === memory.size) {
    touchMemory(key, memory);
    if (scope.authScopeKind === 'bearer-hash') {
      void idbTouchMeta(key, Date.now());
    }
    return memory.blob;
  }
  if (scope.authScopeKind !== 'bearer-hash') return null;
  const meta = await idbReadMeta(key);
  assertEpoch(epoch, scope);
  if (!meta || meta.sha256 !== expectedSha || meta.size <= 0) return null;
  if (meta.authScope !== scope.authScope || meta.transportIdentity !== scope.transportIdentity) {
    return null;
  }
  const data = await idbReadData(key);
  assertEpoch(epoch, scope);
  if (!data || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength !== meta.size) {
    return null;
  }
  const digest = await digestSha256Hex(data.bytes);
  assertEpoch(epoch, scope);
  if (digest !== expectedSha) {
    void idbDeleteMatching((row) => row.key === key);
    return null;
  }
  const blob = new Blob([data.bytes], { type: meta.mime || 'application/octet-stream' });
  const entry: CacheEntry = {
    blob,
    sha256: meta.sha256,
    size: meta.size,
    mime: meta.mime,
    lastAccess: Date.now(),
  };
  memoryCache.set(key, entry, entry.size);
  // Touch meta only — do not rewrite bytes.
  void idbTouchMeta(key, entry.lastAccess);
  return entry.blob;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new AssistantAttachmentCacheError(0, 'aborted', 'aborted');
  }
};

const attachmentPath = (assistantID: string, attachmentID: string): string =>
  `/api/openchamber/assistants/${encodeURIComponent(assistantID)}/contact/attachments/${encodeURIComponent(attachmentID)}`;

const streamDownloadVerified = async (
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
  signal: AbortSignal,
  scope: AssistantAttachmentCacheScope,
  epoch: number,
  maxBytes: number,
): Promise<Blob> => {
  throwIfAborted(signal);
  assertEpoch(epoch, scope);

  let response: Response;
  try {
    response = await runtimeFetch(attachmentPath(assistantID, descriptor.attachmentID), {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error instanceof Error ? error : new AssistantAttachmentCacheError(0, 'aborted');
    }
    throw new AssistantAttachmentCacheError(0, 'unavailable');
  }

  assertEpoch(epoch, scope);

  if (response.status === 401 || response.status === 403) {
    // Clear only the captured scope; never wipe a newer session.
    await clearAssistantAttachmentCacheScope(scope, 'unauthorized');
    if (getRuntimeAuthGeneration() === scope.authGeneration) {
      invalidateRuntimeAuthSession();
    }
    throw new AssistantAttachmentCacheError(response.status, 'unauthorized');
  }
  if (response.status === 413) {
    throw new AssistantAttachmentCacheError(413, 'too-large');
  }
  if (!response.ok) {
    throw new AssistantAttachmentCacheError(
      response.status,
      response.status >= 500 ? 'unavailable' : 'rejected',
    );
  }

  const mime = (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    || descriptor.mime
    || 'application/octet-stream');

  const body = response.body;
  const failAndCancel = async (error: AssistantAttachmentCacheError, reader?: ReadableStreamDefaultReader<Uint8Array>) => {
    try {
      await reader?.cancel(error.message);
    } catch {
      // ignore
    }
    if (!signal.aborted) {
      // Best-effort: abort the request signal owner when we own the controller path.
    }
    throw error;
  };

  if (!body || typeof body.getReader !== 'function') {
    const blob = await response.blob();
    throwIfAborted(signal);
    assertEpoch(epoch, scope);
    if (blob.size > maxBytes) {
      throw new AssistantAttachmentCacheError(413, 'too-large');
    }
    if (blob.size !== descriptor.size) {
      throw new AssistantAttachmentCacheError(0, 'integrity', 'Attachment size failed verification');
    }
    const digest = await digestSha256Hex(blob);
    assertEpoch(epoch, scope);
    if (digest !== descriptor.sha256.toLowerCase()) {
      throw new AssistantAttachmentCacheError(0, 'integrity', 'Attachment SHA-256 mismatch');
    }
    return blob.type === mime ? blob : new Blob([blob], { type: mime });
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      assertEpoch(epoch, scope);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await failAndCancel(new AssistantAttachmentCacheError(413, 'too-large'), reader);
      }
      if (total > descriptor.size) {
        await failAndCancel(
          new AssistantAttachmentCacheError(0, 'integrity', 'Attachment exceeded declared size'),
          reader,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error instanceof Error ? error.message : 'aborted');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  assertEpoch(epoch, scope);
  if (total !== descriptor.size) {
    throw new AssistantAttachmentCacheError(0, 'integrity', 'Attachment size mismatch');
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await digestSha256Hex(merged);
  assertEpoch(epoch, scope);
  if (digest !== descriptor.sha256.toLowerCase()) {
    throw new AssistantAttachmentCacheError(0, 'integrity', 'Attachment SHA-256 mismatch');
  }
  return new Blob([merged], { type: mime });
};

const downloadSingleflight = (
  key: string,
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
  scope: AssistantAttachmentCacheScope,
  epoch: number,
  maxBytes: number,
  externalSignal?: AbortSignal,
): Promise<Blob> => {
  let entry = inflight.get(key);
  if (!entry || entry.epoch !== epoch || !scopeEquals(entry.scope, scope)) {
    const controller = new AbortController();
    const promise = streamDownloadVerified(
      assistantID,
      descriptor,
      controller.signal,
      scope,
      epoch,
      maxBytes,
    ).finally(() => {
      if (inflight.get(key)?.controller === controller) {
        inflight.delete(key);
      }
    });
    entry = { promise, controller, subscribers: 0, scope, epoch };
    inflight.set(key, entry);
  }

  entry.subscribers += 1;

  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const releaseSubscriber = (abortDownload: boolean): void => {
      if (settled) return;
      settled = true;
      entry!.subscribers = Math.max(0, entry!.subscribers - 1);
      if (abortDownload && entry!.subscribers === 0 && inflight.get(key) === entry) {
        entry!.controller.abort(externalSignal?.reason ?? new Error('aborted'));
        inflight.delete(key);
      }
    };

    const onAbort = () => {
      releaseSubscriber(true);
      reject(
        externalSignal?.reason instanceof Error
          ? externalSignal.reason
          : new AssistantAttachmentCacheError(0, 'aborted'),
      );
    };

    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener('abort', onAbort, { once: true });

    entry!.promise.then(
      (blob) => {
        externalSignal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        entry!.subscribers = Math.max(0, entry!.subscribers - 1);
        resolve(blob);
      },
      (error) => {
        externalSignal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        entry!.subscribers = Math.max(0, entry!.subscribers - 1);
        reject(error);
      },
    );
  });
};

const clearMemoryMatching = (predicate: (key: string) => boolean): void => {
  // DualLimitLru has no iterator — rebuild by clearing all when broad, else clear all (keys include scope).
  // Memory is process-local and small; full clear on scope revoke is correct and simple.
  void predicate;
  memoryCache.clear();
};

const abortInflightMatching = (predicate: (entry: InflightDownload, key: string) => boolean, reason: string): void => {
  for (const [key, entry] of [...inflight.entries()]) {
    if (!predicate(entry, key)) continue;
    entry.controller.abort(new Error(reason));
    inflight.delete(key);
  }
};

const releaseDisplayMatching = (predicate: (lease: DisplayLease, key: string) => boolean): void => {
  for (const [key, lease] of [...displayLeases.entries()]) {
    if (!predicate(lease, key)) continue;
    releaseRelayImageDisplayRetain(lease.url);
    releaseRelayImageDisplayUrl(lease.url);
    displayLeases.delete(key);
  }
  for (const [key] of [...displayInflight.entries()]) {
    if (predicate({ url: '', refs: 0, cacheKey: key, epoch: 0 }, key)) {
      displayInflight.delete(key);
    }
  }
};

const releaseAllDisplayLeases = (): void => {
  for (const lease of displayLeases.values()) {
    releaseRelayImageDisplayRetain(lease.url);
    releaseRelayImageDisplayUrl(lease.url);
  }
  displayLeases.clear();
  displayInflight.clear();
};

const abortAllInflight = (reason: string): void => {
  for (const entry of inflight.values()) {
    entry.controller.abort(new Error(reason));
  }
  inflight.clear();
};

/**
 * Clear a captured scope (or current scope when omitted).
 * Awaitable; serialised with IDB writes so late puts cannot resurrect rows.
 */
export const clearAssistantAttachmentCacheScope = async (
  scopeOrReason?: AssistantAttachmentCacheScope | string,
  maybeReason = 'scope-cleared',
): Promise<void> => {
  const scope = typeof scopeOrReason === 'object' && scopeOrReason
    ? scopeOrReason
    : await resolveAssistantAttachmentCacheScope();
  const reason = typeof scopeOrReason === 'string' ? scopeOrReason : maybeReason;
  bumpEpoch();
  abortInflightMatching(
    (entry) => entry.scope.authScope === scope.authScope
      && entry.scope.transportIdentity === scope.transportIdentity,
    reason,
  );
  releaseDisplayMatching((lease) => {
    const parts = lease.cacheKey.split('\u0000');
    return parts[0] === scope.transportIdentity && parts[1] === scope.authScope;
  });
  clearMemoryMatching(() => true);
  await idbDeleteMatching(
    (meta) => meta.authScope === scope.authScope && meta.transportIdentity === scope.transportIdentity,
  );
};

/** Clear every durable partition for a bearer (forget non-active connection). */
export const clearAssistantAttachmentCacheForBearer = async (
  bearer: string,
  reason = 'forget-bearer',
): Promise<void> => {
  const token = bearer.trim();
  if (!token) return;
  const digest = await hashUtf8(token);
  const authScope = `b:${digest}`;
  bumpEpoch();
  abortInflightMatching((entry) => entry.scope.authScope === authScope, reason);
  releaseDisplayMatching((lease) => lease.cacheKey.split('\u0000')[1] === authScope);
  clearMemoryMatching(() => true);
  await idbDeleteMatching((meta) => meta.authScope === authScope);
};

export const clearAssistantAttachmentCacheAll = async (reason = 'cleared'): Promise<void> => {
  bumpEpoch();
  abortAllInflight(reason);
  releaseAllDisplayLeases();
  memoryCache.clear();
  await withIdbFence(async () => {
    const db = await openIdb();
    if (!db) return;
    try {
      const tx = db.transaction([IDB_META, IDB_DATA], 'readwrite');
      tx.objectStore(IDB_META).clear();
      tx.objectStore(IDB_DATA).clear();
      await waitTx(tx);
    } catch {
      // ignore
    }
  });
};

/** Live-only cleanup: memory, display, inflight. Disk partitions stay. */
const liveCleanupOnly = (reason: string): void => {
  bumpEpoch();
  abortAllInflight(reason);
  releaseAllDisplayLeases();
  memoryCache.clear();
};

/**
 * Auth generation fanout:
 * - endpoint-switch: transport already points at the target; live cleanup only
 *   (A→B→A must keep disk for A). Auth events still fire — no silent suppress.
 * - invalidate / credential: live cleanup + durable eviction of captured prior
 *   bearer digest when present; otherwise current-transport disk wipe.
 */
const onAuthGenerationChanged = (detail: RuntimeAuthGenerationDetail): void => {
  if (detail.reason === 'endpoint-switch') {
    liveCleanupOnly('endpoint-switch');
    return;
  }
  liveCleanupOnly(detail.reason === 'invalidate' ? 'auth-invalidate' : 'auth-credential');
  if (detail.previousBearerDigest) {
    const authScope = `b:${detail.previousBearerDigest}`;
    void idbDeleteMatching((meta) => meta.authScope === authScope);
    return;
  }
  const transport = getRuntimeTransportIdentity();
  void idbDeleteMatching((meta) => meta.transportIdentity === transport);
};

const ensureLifecycleHooks = (): void => {
  if (typeof window === 'undefined') return;
  if (!transportUnsubscribe) {
    transportUnsubscribe = subscribeRuntimeEndpointChanged(() => {
      // Endpoint event: live only. Durable partitions key by transport+auth.
      liveCleanupOnly('transport-changed');
    });
  }
  if (!authUnsubscribe) {
    authUnsubscribe = subscribeRuntimeAuthGeneration((detail) => {
      onAuthGenerationChanged(detail);
    });
  }
};

const requireDescriptor = (
  descriptor: AssistantAttachmentDescriptor,
  maxBytes: number,
): AssistantAttachmentDescriptor => {
  if (!isAssistantAttachmentDescriptor(descriptor)) {
    throw new AssistantAttachmentCacheError(0, 'rejected', 'Invalid attachment descriptor');
  }
  if (descriptor.size > maxBytes) {
    throw new AssistantAttachmentCacheError(413, 'too-large');
  }
  return {
    ...descriptor,
    sha256: descriptor.sha256.toLowerCase(),
  };
};

/**
 * Fetch (or cache-hit) the attachment Blob.
 * Upload-sized descriptors (≤25 MiB). Verified bytes only.
 */
export const getAssistantAttachmentBlob = async (
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> => {
  ensureLifecycleHooks();
  throwIfAborted(options.signal);

  const id = typeof assistantID === 'string' ? assistantID.trim() : '';
  if (!id) throw new AssistantAttachmentCacheError(0, 'rejected', 'assistantID is required');
  const desc = requireDescriptor(descriptor, ASSISTANT_ATTACHMENT_MAX_BYTES);
  const epoch = cacheEpoch;
  const scope = await resolveAssistantAttachmentCacheScope();
  assertEpoch(epoch, scope);
  const key = buildCacheKey(scope, id, desc);

  const cached = await readCached(key, desc.sha256, scope, epoch);
  if (cached) {
    throwIfAborted(options.signal);
    assertEpoch(epoch, scope);
    return cached;
  }

  const blob = await downloadSingleflight(
    key,
    id,
    desc,
    scope,
    epoch,
    ASSISTANT_ATTACHMENT_MAX_BYTES,
    options.signal,
  );
  throwIfAborted(options.signal);
  assertEpoch(epoch, scope);
  await remember(key, blob, { sha256: desc.sha256, size: desc.size, mime: desc.mime || blob.type }, scope, epoch);
  assertEpoch(epoch, scope);
  return blob;
};

const acquireDisplayLease = (cacheKey: string, url: string, epoch: number): { url: string; release: () => void } => {
  if (!isRelayImageDisplayUrlLive(url) || !retainRelayImageDisplayUrl(url)) {
    releaseRelayImageDisplayUrl(url);
    throw new AssistantAttachmentCacheError(0, 'unavailable', 'Display URL is not live');
  }
  let lease = displayLeases.get(cacheKey);
  if (!lease || lease.url !== url || lease.epoch !== epoch) {
    if (lease && lease.url !== url) {
      releaseRelayImageDisplayUrl(lease.url);
    }
    lease = { url, refs: 0, cacheKey, epoch };
    displayLeases.set(cacheKey, lease);
  }
  lease.refs += 1;
  let released = false;
  return {
    url,
    release: () => {
      if (released) return;
      released = true;
      const current = displayLeases.get(cacheKey);
      releaseRelayImageDisplayRetain(url);
      if (!current || current.url !== url) {
        releaseRelayImageDisplayUrl(url);
        return;
      }
      current.refs -= 1;
      if (current.refs <= 0) {
        displayLeases.delete(cacheKey);
        releaseRelayImageDisplayUrl(current.url);
      }
    },
  };
};

/**
 * Resolve bytes + open native/object URL once under the flight controller signal.
 * Reuses downloadSingleflight (same subscriber/abort semantics as blob download).
 */
const materializeDisplayUrl = async (
  cacheKey: string,
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
  flightSignal: AbortSignal,
  epoch: number,
  scope: AssistantAttachmentCacheScope,
): Promise<string> => {
  const existing = displayLeases.get(cacheKey);
  if (existing && existing.epoch === epoch && isRelayImageDisplayUrlLive(existing.url)) {
    return existing.url;
  }

  const desc = requireDescriptor(descriptor, ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES);
  const key = buildCacheKey(scope, assistantID.trim(), desc);
  let blob = await readCached(key, desc.sha256, scope, epoch);
  throwIfAborted(flightSignal);
  assertEpoch(epoch, scope);
  if (!blob) {
    // Always go through download singleflight with the flight-owned signal so a
    // single subscriber abort cannot tear down peers (same helper as blob path).
    blob = await downloadSingleflight(
      key,
      assistantID.trim(),
      desc,
      scope,
      epoch,
      desc.size > ASSISTANT_ATTACHMENT_MAX_BYTES
        ? ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES
        : ASSISTANT_ATTACHMENT_MAX_BYTES,
      flightSignal,
    );
    assertEpoch(epoch, scope);
    throwIfAborted(flightSignal);
    if (desc.size > ASSISTANT_ATTACHMENT_MAX_BYTES) {
      memoryCache.set(key, {
        blob,
        sha256: desc.sha256,
        size: desc.size,
        mime: desc.mime || blob.type,
        lastAccess: Date.now(),
      }, desc.size);
    } else {
      await remember(
        key,
        blob,
        { sha256: desc.sha256, size: desc.size, mime: desc.mime || blob.type },
        scope,
        epoch,
      );
      assertEpoch(epoch, scope);
    }
  }

  throwIfAborted(flightSignal);
  assertEpoch(epoch, scope);

  const url = await streamVerifiedBlobDisplayUrl(
    blob,
    flightSignal,
    { mimeType: desc.mime || blob.type },
  );
  throwIfAborted(flightSignal);
  assertEpoch(epoch, scope);
  return url;
};

const releaseDisplayFlightOrphan = (flight: DisplayInflight, cacheKey: string): void => {
  if (flight.releasedOrphan) return;
  if (flight.subscribers > 0) return;
  flight.releasedOrphan = true;
  if (flight.url) {
    releaseRelayImageDisplayUrl(flight.url);
    flight.url = null;
  }
  if (displayInflight.get(cacheKey) === flight) {
    displayInflight.delete(cacheKey);
  }
};

/**
 * Materialize a display URL (native openchamber-asset or object URL).
 * Flight owns its AbortController; external subscriber aborts only leave the
 * flight when the last subscriber exits (mirrors downloadSingleflight).
 */
export const getAssistantAttachmentDisplay = async (
  assistantID: string,
  descriptor: AssistantAttachmentDescriptor,
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; release: () => void }> => {
  ensureLifecycleHooks();
  throwIfAborted(options.signal);

  const id = typeof assistantID === 'string' ? assistantID.trim() : '';
  if (!id) throw new AssistantAttachmentCacheError(0, 'rejected', 'assistantID is required');
  const desc = requireDescriptor(descriptor, ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES);
  const epoch = cacheEpoch;
  const scope = await resolveAssistantAttachmentCacheScope();
  assertEpoch(epoch, scope);
  const cacheKey = buildCacheKey(scope, id, desc);

  let flight = displayInflight.get(cacheKey);
  if (!flight || flight.epoch !== epoch) {
    if (flight && flight.epoch !== epoch) {
      flight.controller.abort(new Error('stale-epoch'));
      releaseDisplayFlightOrphan(flight, cacheKey);
    }
    const controller = new AbortController();
    const created: DisplayInflight = {
      promise: Promise.resolve(''),
      controller,
      subscribers: 0,
      epoch,
      url: null,
      releasedOrphan: false,
    };
    const promise = materializeDisplayUrl(cacheKey, id, desc, controller.signal, epoch, scope)
      .then((url) => {
        created.url = url;
        // Epoch flipped or everyone left while we were opening the URL.
        if (created.subscribers === 0 || created.epoch !== cacheEpoch || created.releasedOrphan) {
          releaseRelayImageDisplayUrl(url);
          created.url = null;
          created.releasedOrphan = true;
          if (displayInflight.get(cacheKey) === created) displayInflight.delete(cacheKey);
          throw new AssistantAttachmentCacheError(0, 'stale', 'Display URL orphaned before lease');
        }
        return url;
      })
      .catch((error) => {
        // Failure settlement: drop this flight by identity immediately so a
        // retry never reuses the rejected Promise (finally may still see subs>0
        // while waiters are rejecting). Concurrent waiters still observe error.
        if (displayInflight.get(cacheKey) === created) {
          displayInflight.delete(cacheKey);
        }
        if (created.url) {
          releaseRelayImageDisplayUrl(created.url);
          created.url = null;
        }
        created.releasedOrphan = true;
        throw error;
      })
      .finally(() => {
        if (displayInflight.get(cacheKey) === created && created.subscribers === 0) {
          releaseDisplayFlightOrphan(created, cacheKey);
        }
      });
    created.promise = promise;
    flight = created;
    displayInflight.set(cacheKey, flight);
  }

  flight.subscribers += 1;

  return new Promise((resolve, reject) => {
    let settled = false;

    const leaveFlight = (abortIfLast: boolean): void => {
      flight!.subscribers = Math.max(0, flight!.subscribers - 1);
      if (flight!.subscribers === 0) {
        if (abortIfLast) {
          flight!.controller.abort(options.signal?.reason ?? new Error('aborted'));
        }
        // Last waiter left (abort or failure): drop orphan URL + map entry by identity.
        releaseDisplayFlightOrphan(flight!, cacheKey);
        if (displayInflight.get(cacheKey) === flight) {
          displayInflight.delete(cacheKey);
        }
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      leaveFlight(true);
      reject(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new AssistantAttachmentCacheError(0, 'aborted'),
      );
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    flight!.promise.then(
      (url) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (settled) {
          // This waiter already left; do not acquire a lease.
          return;
        }
        settled = true;
        flight!.subscribers = Math.max(0, flight!.subscribers - 1);
        if (flight!.subscribers === 0 && displayInflight.get(cacheKey) === flight) {
          displayInflight.delete(cacheKey);
        }
        try {
          if (flight!.epoch !== cacheEpoch) {
            releaseRelayImageDisplayUrl(url);
            throw new AssistantAttachmentCacheError(0, 'stale', 'Display epoch changed');
          }
          resolve(acquireDisplayLease(cacheKey, url, epoch));
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        leaveFlight(false);
        reject(error);
      },
    );
  });
};

/** Test helper: drop in-memory LRU / leases / inflight without touching IDB. */
export const clearAssistantAttachmentMemoryForTests = (): void => {
  bumpEpoch();
  abortAllInflight('test-memory-clear');
  releaseAllDisplayLeases();
  memoryCache.clear();
};

/** Test helper: reset module state between suites. */
export const resetAssistantAttachmentCacheForTests = async (): Promise<void> => {
  await clearAssistantAttachmentCacheAll('test-reset');
  transportUnsubscribe?.();
  transportUnsubscribe = null;
  authUnsubscribe?.();
  authUnsubscribe = null;
  idbDisabled = false;
  idbPromise = null;
  idbFence = Promise.resolve();
  const factory = getIndexedDB();
  if (factory) {
    await new Promise<void>((resolve) => {
      try {
        const req = factory.deleteDatabase(IDB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }
};
