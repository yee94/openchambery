/** Assistant descriptor/error and display adapter. Complete bytes and flights
 * belong to runtime-file-resource; there is no Assistant body database or LRU. */
import { ASSISTANT_ATTACHMENT_MAX_BYTES, isAssistantAttachmentDescriptor, type AssistantAttachmentDescriptor } from './assistant-attachment-upload';
import { clearRuntimeImageCacheLeases, forgetFileResourceTag, readVerifiedFileResource } from './runtime-file-resource';
import { getRuntimeAuthGeneration, getRuntimeBearerTokenSync, invalidateRuntimeAuthSession, subscribeRuntimeAuthGeneration } from './runtime-auth';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { runtimeFetch } from './runtime-fetch';
import { isRelayImageDisplayUrlLive, releaseRelayImageDisplayRetain, releaseRelayImageDisplayUrl, retainRelayImageDisplayUrl, RELAY_IMAGE_MAX_BYTES, streamVerifiedBlobDisplayUrl } from './relay/relay-image-stream';

const ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES = RELAY_IMAGE_MAX_BYTES;
type AssistantAttachmentAuthScopeKind = 'bearer-hash' | 'memory-ephemeral';
type AssistantAttachmentCacheScope = {
  transportIdentity: string; authScope: string; authScopeKind: AssistantAttachmentAuthScopeKind; authGeneration: number;
};
class AssistantAttachmentCacheError extends Error {
  constructor(readonly status: number, readonly code: 'unavailable' | 'too-large' | 'rejected' | 'integrity' | 'aborted' | 'unauthorized' | 'stale', message = 'Assistant attachment cache error') {
    super(message); this.name = 'AssistantAttachmentCacheError';
  }
}
const hashUtf8 = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
let epoch = 0;
let stopTransport: (() => void) | undefined;
let stopAuth: (() => void) | undefined;
let retiredLegacyStore = false;
type Display = { url: string; refs: number };
type DisplayFlight = { controller: AbortController; promise: Promise<string>; refs: number; url?: string };
const displays = new Map<string, Display>();
const flights = new Map<string, DisplayFlight>();
const requests = new Set<AbortController>();
export const getAssistantAttachmentCacheEpoch = (): number => epoch;
export const resolveAssistantAttachmentCacheScope = async (options: { bearer?: string | null; transportIdentity?: string; authGeneration?: number } = {}): Promise<AssistantAttachmentCacheScope> => {
  const transportIdentity = options.transportIdentity ?? getRuntimeTransportIdentity();
  const authGeneration = options.authGeneration ?? getRuntimeAuthGeneration();
  const bearer = (options.bearer ?? getRuntimeBearerTokenSync()).trim();
  return { transportIdentity, authGeneration, authScope: bearer ? `b:${await hashUtf8(bearer)}` : `m:${authGeneration}`, authScopeKind: bearer ? 'bearer-hash' : 'memory-ephemeral' };
};
export const getAssistantAttachmentCacheCapabilities = async () => {
  const scope = await resolveAssistantAttachmentCacheScope();
  return { durableIndexedDB: scope.authScopeKind === 'bearer-hash', authScopeKind: scope.authScopeKind,
    reason: scope.authScopeKind === 'bearer-hash' ? 'Verified bytes use the shared file store.' : 'Cookie-only descriptor reads retain process-local authorization scope.' };
};
const scopeTag = (scope: AssistantAttachmentCacheScope) => `assistant:${scope.transportIdentity}:${scope.authScope}`;
const bearerTag = (authScope: string) => `assistant-auth:${authScope}`;
const cleanup = () => {
  epoch++;
  for (const controller of requests) controller.abort();
  requests.clear();
  for (const flight of flights.values()) { flight.controller.abort(); if (flight.url) releaseRelayImageDisplayUrl(flight.url); }
  flights.clear();
  for (const display of displays.values()) {
    for (let i = 0; i < display.refs; i++) releaseRelayImageDisplayRetain(display.url);
    releaseRelayImageDisplayUrl(display.url);
  }
  displays.clear();
};
const ensureLifecycle = () => {
  if (!retiredLegacyStore && globalThis.indexedDB) {
    retiredLegacyStore = true;
    // Disposable legacy bodies are never read or written again. A blocked old
    // tab can close later; removal must not block a valid attachment operation.
    try { globalThis.indexedDB.deleteDatabase('openchamber-assistant-attachments'); } catch { /* Storage may be unavailable. */ }
  }
  if (!stopTransport) stopTransport = subscribeRuntimeEndpointChanged(cleanup);
  if (!stopAuth) stopAuth = subscribeRuntimeAuthGeneration(detail => {
    cleanup();
    if (detail.reason !== 'endpoint-switch') void forgetFileResourceTag(detail.previousBearerDigest ? bearerTag(`b:${detail.previousBearerDigest}`) : undefined);
  });
};
export const clearAssistantAttachmentCacheScope = async (scopeOrReason?: AssistantAttachmentCacheScope | string, _reason = 'scope-cleared'): Promise<void> => {
  const scope = typeof scopeOrReason === 'object' ? scopeOrReason : await resolveAssistantAttachmentCacheScope();
  cleanup(); await forgetFileResourceTag(scopeTag(scope));
};
export const clearAssistantAttachmentCacheForBearer = async (bearer: string, _reason = 'forget-bearer'): Promise<void> => {
  if (!bearer.trim()) return;
  const tag = bearerTag(`b:${await hashUtf8(bearer.trim())}`);
  cleanup(); await forgetFileResourceTag(tag);
};
export const clearAssistantAttachmentCacheAll = async (_reason = 'cleared'): Promise<void> => {
  cleanup(); await forgetFileResourceTag();
};
const requireDescriptor = (id: string, descriptor: AssistantAttachmentDescriptor, maxBytes: number) => {
  if (!id.trim() || !isAssistantAttachmentDescriptor(descriptor)) throw new AssistantAttachmentCacheError(0, 'rejected');
  if (descriptor.size > maxBytes) throw new AssistantAttachmentCacheError(413, 'too-large');
};
const readBlob = async (id: string, descriptor: AssistantAttachmentDescriptor, maxBytes: number, signal?: AbortSignal): Promise<Blob> => {
  ensureLifecycle(); requireDescriptor(id, descriptor, maxBytes);
  signal?.throwIfAborted();
  const capturedEpoch = epoch;
  const scope = await resolveAssistantAttachmentCacheScope();
  if (capturedEpoch !== epoch) throw new AssistantAttachmentCacheError(0, 'stale');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  requests.add(controller);
  let terminalError: AssistantAttachmentCacheError | undefined;
  try {
    signal?.throwIfAborted();
    const result = await readVerifiedFileResource({
      identity: `/api/openchamber/assistants/${encodeURIComponent(id.trim())}/contact/attachments/${encodeURIComponent(descriptor.attachmentID)}`,
      sha256: descriptor.sha256.toLowerCase(), size: descriptor.size, mime: descriptor.mime, filename: descriptor.filename,
      persistent: scope.authScopeKind === 'bearer-hash', tags: [scopeTag(scope), bearerTag(scope.authScope)], signal: controller.signal, maxBytes,
      load: async downloadSignal => {
        const response = await runtimeFetch(`/api/openchamber/assistants/${encodeURIComponent(id.trim())}/contact/attachments/${encodeURIComponent(descriptor.attachmentID)}`, { method: 'GET', cache: 'no-store', signal: downloadSignal });
        if (response.status === 401 || response.status === 403) {
          terminalError = new AssistantAttachmentCacheError(response.status, 'unauthorized');
          await clearAssistantAttachmentCacheScope(scope, 'unauthorized');
          if (getRuntimeAuthGeneration() === scope.authGeneration) invalidateRuntimeAuthSession();
          throw new AssistantAttachmentCacheError(response.status, 'unauthorized');
        }
        if (!response.ok) throw new AssistantAttachmentCacheError(response.status, response.status === 413 ? 'too-large' : response.status >= 500 ? 'unavailable' : 'rejected');
        return response;
      },
    });
    if (capturedEpoch !== epoch) throw new AssistantAttachmentCacheError(0, 'stale');
    return result;
  } catch (error) {
    if (terminalError) throw terminalError;
    if (error instanceof AssistantAttachmentCacheError) throw error;
    if (capturedEpoch !== epoch) throw new AssistantAttachmentCacheError(0, 'stale');
    if (controller.signal.aborted) throw new AssistantAttachmentCacheError(0, 'aborted');
    if (/descriptor limit|streaming destination/i.test(String(error))) throw new AssistantAttachmentCacheError(413, 'too-large');
    throw new AssistantAttachmentCacheError(0, /fingerprint|size|changed|truncated/i.test(String(error)) ? 'integrity' : 'unavailable');
  } finally { requests.delete(controller); signal?.removeEventListener('abort', abort); }
};
export const getAssistantAttachmentBlob = (id: string, descriptor: AssistantAttachmentDescriptor, options: { signal?: AbortSignal } = {}): Promise<Blob> =>
  readBlob(id, descriptor, ASSISTANT_ATTACHMENT_MAX_BYTES, options.signal);

export const getAssistantAttachmentDisplay = async (id: string, descriptor: AssistantAttachmentDescriptor, options: { signal?: AbortSignal } = {}): Promise<{ url: string; release: () => void }> => {
  ensureLifecycle(); requireDescriptor(id, descriptor, ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES);
  options.signal?.throwIfAborted();
  const capturedEpoch = epoch;
  const scope = await resolveAssistantAttachmentCacheScope();
  const key = JSON.stringify([scopeTag(scope), id, descriptor.attachmentID, descriptor.sha256]);
  const lease = (url: string) => {
    if (capturedEpoch !== epoch || !isRelayImageDisplayUrlLive(url) || !retainRelayImageDisplayUrl(url)) {
      releaseRelayImageDisplayUrl(url); throw new AssistantAttachmentCacheError(0, 'stale');
    }
    const display = displays.get(key)?.url === url ? displays.get(key)! : { url, refs: 0 };
    display.refs++; displays.set(key, display);
    let released = false;
    return { url, release: () => {
      if (released) return; released = true;
      if (displays.get(key) !== display) return;
      releaseRelayImageDisplayRetain(url);
      if (--display.refs === 0) { displays.delete(key); releaseRelayImageDisplayUrl(url); }
    } };
  };
  const existing = displays.get(key);
  if (existing && isRelayImageDisplayUrlLive(existing.url)) return lease(existing.url);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const created: DisplayFlight = { controller, refs: 0, promise: Promise.resolve('') };
    created.promise = readBlob(id, descriptor, ASSISTANT_ATTACHMENT_DISPLAY_MAX_BYTES, controller.signal)
      .then(blob => streamVerifiedBlobDisplayUrl(blob, controller.signal, { mimeType: descriptor.mime || blob.type }))
      .then(url => {
        created.url = url;
        if (capturedEpoch !== epoch || controller.signal.aborted || created.refs === 0) { releaseRelayImageDisplayUrl(url); throw new AssistantAttachmentCacheError(0, 'stale'); }
        return url;
      }).catch(error => { if (flights.get(key) === created) flights.delete(key); throw error; });
    flight = created; flights.set(key, flight);
  }
  const current = flight;
  current.refs++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = (cancel: boolean) => {
      if (--current.refs === 0) {
        if (cancel) current.controller.abort();
        if (flights.get(key) === current) flights.delete(key);
        if (cancel && current.url && !displays.has(key)) releaseRelayImageDisplayUrl(current.url);
      }
    };
    const abort = () => { if (!settled) { settled = true; leave(true); reject(new AssistantAttachmentCacheError(0, 'aborted')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    current.promise.then(url => {
      options.signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      try { resolve(lease(url)); } catch (error) { reject(error); }
      leave(false);
    }, error => {
      options.signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true; leave(false); reject(error);
    });
  });
};
export const clearAssistantAttachmentMemoryForTests = (): void => { cleanup(); clearRuntimeImageCacheLeases(); };
export const resetAssistantAttachmentCacheForTests = async (): Promise<void> => {
  await clearAssistantAttachmentCacheAll('test-reset'); stopTransport?.(); stopTransport = undefined; stopAuth?.(); stopAuth = undefined;
};
