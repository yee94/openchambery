/**
 * Send / stop / queue hooks for Lynx chat.
 * When a connect runtime exists, calls official OpenCode routes.
 * Without a runtime, returns explicit failures — never fake-success.
 *
 * Queue: prefer Cap `/api/openchamber/message-queue` when runtimeFetch can
 * reach it (list/admit/reorder/remove/send-now; flush = send-now first).
 * If the server is unavailable (501 / transport), keep the local queue path.
 * Never invent server success.
 */
import {
  abortSession,
  promptAsync,
  type LynxSessionApiDeps,
} from './sessionApi';
import { reorderLynxQueueChips } from './queuedMessageChips';
import {
  admitLynxTextQueueItem,
  fetchLynxMessageQueueScope,
  fetchLynxMessageQueueScopeForSession,
  flushLynxQueueScopeFirst,
  isLynxMessageQueueUnavailable,
  lynxQueueItemsToPrompts,
  removeLynxQueueItem,
  reorderLynxQueueScope,
  sendLynxQueueItemNow,
  type LynxMessageQueueScope,
} from './messageQueueServer';

export type LynxComposerModel = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export type LynxQueuedPrompt = {
  id: string;
  text: string;
  createdAt: number;
  /** Present when mirrored from Cap server message-queue. */
  rowVersion?: number;
};

export type LynxComposerActionResult =
  | { status: 'ok'; messageId?: string; aborted?: true; queuedId?: string }
  | { status: 'failed'; error: string; reason: 'no-runtime' | 'http' | 'invalid' | 'busy-steer-required' | 'unavailable' };

export type LynxComposerActions = {
  send: (text: string, options?: { messageId?: string; delivery?: 'steer' }) => Promise<LynxComposerActionResult>;
  stop: () => Promise<LynxComposerActionResult>;
  queue: (text: string) => Promise<LynxComposerActionResult>;
  flushQueue: () => Promise<LynxComposerActionResult>;
  /** Cap chip Send — server send-now when authoritative; else prompt_async. */
  sendNow: (queueItemId: string) => Promise<LynxComposerActionResult>;
  /** Cap chip Remove — server DELETE when authoritative; else local drop. */
  removeFromQueue: (queueItemId: string) => Promise<LynxComposerActionResult>;
  /** Portable reorder (no @dnd-kit) — server PUT order when authoritative. */
  reorderQueue: (activeId: string, overId: string) => Promise<LynxComposerActionResult>;
  /** Refresh chips from Cap server scope when authoritative; no-op on local. */
  refreshQueue: () => Promise<LynxComposerActionResult>;
  getQueue: () => readonly LynxQueuedPrompt[];
  /** 'server' | 'local' | 'unknown' (not yet probed). */
  getQueueMode: () => 'server' | 'local' | 'unknown';
};

export type CreateLynxComposerActionsInput = {
  sessionId: string;
  directory?: string | null;
  model: LynxComposerModel;
  /** Null / undefined = not connected — actions fail honestly. */
  sessionApi: LynxSessionApiDeps | null;
  /** When true, follow-ups go to the local/server queue instead of prompt_async. */
  sessionIsWorking?: () => boolean;
  followUpBehavior?: 'steer' | 'queue';
  /**
   * Prefer Cap server message-queue when runtime is present (default true).
   * Falls back to local queue only when the server reports unavailable.
   */
  preferServerQueue?: boolean;
  now?: () => number;
  createId?: () => string;
};

export function createLynxComposerActions(
  input: CreateLynxComposerActionsInput,
): LynxComposerActions {
  let queue: LynxQueuedPrompt[] = [];
  let queueMode: 'server' | 'local' | 'unknown' = 'unknown';
  let serverScope: LynxMessageQueueScope | null = null;
  const now = input.now ?? (() => Date.now());
  const createId = input.createId ?? (() => `queue_${now().toString(36)}`);
  const followUpBehavior = input.followUpBehavior ?? 'queue';
  const preferServerQueue = input.preferServerQueue !== false;

  const requireApi = (): LynxSessionApiDeps | LynxComposerActionResult => {
    if (!input.sessionApi) {
      return {
        status: 'failed',
        error: 'No connect runtime — send/stop/queue cannot call OpenCode APIs',
        reason: 'no-runtime',
      };
    }
    return input.sessionApi;
  };

  const runtimeFetch = () => input.sessionApi?.runtimeFetch;

  const directory = () => (input.directory?.trim() || '/');

  const applyServerScope = (scope: LynxMessageQueueScope | null) => {
    serverScope = scope;
    queueMode = 'server';
    queue = scope ? lynxQueueItemsToPrompts(scope.items) : [];
  };

  const useLocalQueue = () => {
    queueMode = 'local';
    serverScope = null;
  };

  const refreshServerScope = async (): Promise<LynxComposerActionResult> => {
    const api = requireApi();
    if ('status' in api) return api;
    const result = await fetchLynxMessageQueueScopeForSession(api.runtimeFetch, {
      directory: directory(),
      sessionID: input.sessionId,
    });
    if (result.status !== 'ok') {
      if (isLynxMessageQueueUnavailable(result)) {
        useLocalQueue();
        return { status: 'ok' };
      }
      return {
        status: 'failed',
        error: result.error,
        reason: result.reason === 'invalid' ? 'invalid' : 'http',
      };
    }
    applyServerScope(result.value);
    return { status: 'ok' };
  };

  const ensureQueueBackend = async (): Promise<'server' | 'local' | LynxComposerActionResult> => {
    const api = requireApi();
    if ('status' in api) return api;
    if (!preferServerQueue) {
      useLocalQueue();
      return 'local';
    }
    if (queueMode === 'server') return 'server';
    if (queueMode === 'local') return 'local';
    const probed = await refreshServerScope();
    if (probed.status !== 'ok') return probed;
    return queueMode === 'server' ? 'server' : 'local';
  };

  const reloadKnownScope = async (): Promise<LynxComposerActionResult> => {
    const api = requireApi();
    if ('status' in api) return api;
    if (!serverScope) return refreshServerScope();
    const result = await fetchLynxMessageQueueScope(api.runtimeFetch, serverScope.scopeID, {
      offset: 0,
      limit: 8,
    });
    if (result.status !== 'ok') {
      if (isLynxMessageQueueUnavailable(result)) {
        useLocalQueue();
        return { status: 'ok' };
      }
      return {
        status: 'failed',
        error: result.error,
        reason: result.reason === 'invalid' ? 'invalid' : 'http',
      };
    }
    applyServerScope(result.value);
    return { status: 'ok' };
  };

  const promptQueuedItem = async (
    api: LynxSessionApiDeps,
    item: LynxQueuedPrompt,
  ): Promise<LynxComposerActionResult> => {
    const result = await promptAsync(api, {
      sessionId: input.sessionId,
      directory: input.directory,
      text: item.text,
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      agent: input.model.agent,
      variant: input.model.variant,
    });
    if (result.status !== 'ok') {
      return { status: 'failed', error: result.error, reason: 'http' };
    }
    return { status: 'ok', messageId: result.messageId };
  };

  return {
    getQueue: () => queue.slice(),
    getQueueMode: () => queueMode,

    refreshQueue: async () => {
      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;
      if (backend === 'local') return { status: 'ok' };
      return reloadKnownScope();
    },

    send: async (text, options) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return { status: 'failed', error: 'empty prompt', reason: 'invalid' };
      }
      const api = requireApi();
      if ('status' in api) return api;

      const working = input.sessionIsWorking?.() ?? false;
      if (working && followUpBehavior === 'queue' && options?.delivery !== 'steer') {
        return {
          status: 'failed',
          error: 'session busy — use queue() or delivery:steer',
          reason: 'busy-steer-required',
        };
      }

      const result = await promptAsync(api, {
        sessionId: input.sessionId,
        directory: input.directory,
        text: trimmed,
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        agent: input.model.agent,
        variant: input.model.variant,
        messageId: options?.messageId,
        delivery: options?.delivery,
      });
      if (result.status === 'ok') return { status: 'ok', messageId: result.messageId };
      return { status: 'failed', error: result.error, reason: 'http' };
    },

    stop: async () => {
      const api = requireApi();
      if ('status' in api) return api;
      const result = await abortSession(api, {
        sessionId: input.sessionId,
        directory: input.directory,
      });
      if (result.status === 'ok') return { status: 'ok', aborted: true };
      return { status: 'failed', error: result.error, reason: 'http' };
    },

    queue: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return { status: 'failed', error: 'empty prompt', reason: 'invalid' };
      }
      const api = requireApi();
      if ('status' in api) return api;

      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;

      if (backend === 'server') {
        const id = createId();
        const createdAt = now();
        const admitted = await admitLynxTextQueueItem(api.runtimeFetch, {
          requestID: `request-${id}`,
          expectedRevision: serverScope?.revision,
          scope: { directory: directory(), sessionID: input.sessionId },
          item: {
            queueItemID: id.startsWith('queued-') ? id : `queued-${id}`,
            operationID: `operation-${id}`,
            messageID: `msg_${id}`,
            content: trimmed,
            attachments: [],
            attachmentIssues: [],
            createdAt,
            sendConfig: {
              providerID: input.model.providerID,
              modelID: input.model.modelID,
              ...(input.model.agent ? { agent: input.model.agent } : {}),
              ...(input.model.variant ? { variant: input.model.variant } : {}),
            },
          },
        });
        if (admitted.status !== 'ok') {
          if (isLynxMessageQueueUnavailable(admitted)) {
            useLocalQueue();
            const localItem: LynxQueuedPrompt = { id, text: trimmed, createdAt };
            queue.push(localItem);
            return { status: 'ok', queuedId: localItem.id };
          }
          return {
            status: 'failed',
            error: admitted.error,
            reason: admitted.reason === 'invalid' ? 'invalid' : 'http',
          };
        }
        const queuedId = admitted.value.queueItemID ?? (id.startsWith('queued-') ? id : `queued-${id}`);
        const refreshed = await reloadKnownScope();
        if (refreshed.status !== 'ok') {
          // Admission committed — surface id even if refresh races.
          if (!queue.some((entry) => entry.id === queuedId)) {
            queue.push({
              id: queuedId,
              text: trimmed,
              createdAt,
              rowVersion: admitted.value.rowVersion,
            });
          }
        }
        return { status: 'ok', queuedId };
      }

      const item: LynxQueuedPrompt = {
        id: createId(),
        text: trimmed,
        createdAt: now(),
      };
      queue.push(item);
      return { status: 'ok', queuedId: item.id };
    },

    flushQueue: async () => {
      const api = requireApi();
      if ('status' in api) return api;
      if (queue.length === 0 && !serverScope?.items.length) {
        return { status: 'failed', error: 'queue empty', reason: 'invalid' };
      }
      if (input.sessionIsWorking?.()) {
        return {
          status: 'failed',
          error: 'session still working — wait or stop before flush',
          reason: 'busy-steer-required',
        };
      }

      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;

      if (backend === 'server') {
        if (!serverScope || serverScope.items.length === 0) {
          const refreshed = await reloadKnownScope();
          if (refreshed.status !== 'ok') return refreshed;
        }
        if (!serverScope || serverScope.items.length === 0) {
          return { status: 'failed', error: 'queue empty', reason: 'invalid' };
        }
        const flushed = await flushLynxQueueScopeFirst(api.runtimeFetch, serverScope, {
          requestID: `request-${createId()}`,
        });
        if (flushed.status !== 'ok') {
          return {
            status: 'failed',
            error: flushed.error,
            reason: flushed.reason === 'unavailable' ? 'unavailable' : flushed.reason === 'invalid' ? 'invalid' : 'http',
          };
        }
        await reloadKnownScope();
        return { status: 'ok', messageId: flushed.value.queueItemID };
      }

      const next = queue[0]!;
      const sent = await promptQueuedItem(api, next);
      if (sent.status !== 'ok') return sent;
      queue.shift();
      return sent;
    },

    sendNow: async (queueItemId) => {
      const api = requireApi();
      if ('status' in api) return api;
      const id = queueItemId.trim();
      if (!id) {
        return { status: 'failed', error: 'queue item id required', reason: 'invalid' };
      }
      if (input.sessionIsWorking?.()) {
        return {
          status: 'failed',
          error: 'session still working — wait or stop before send-now',
          reason: 'busy-steer-required',
        };
      }

      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;

      if (backend === 'server') {
        if (!serverScope) {
          const refreshed = await reloadKnownScope();
          if (refreshed.status !== 'ok') return refreshed;
        }
        const latest = serverScope?.items.find((entry) => entry.queueItemID === id);
        if (!latest || !serverScope) {
          return { status: 'failed', error: 'queue item not found', reason: 'invalid' };
        }
        const sent = await sendLynxQueueItemNow(api.runtimeFetch, id, {
          requestID: `request-${createId()}`,
          expectedRevision: serverScope.revision,
          expectedRowVersion: latest.rowVersion,
        });
        if (sent.status !== 'ok') {
          return {
            status: 'failed',
            error: sent.error,
            reason: sent.reason === 'unavailable' ? 'unavailable' : sent.reason === 'invalid' ? 'invalid' : 'http',
          };
        }
        await reloadKnownScope();
        return { status: 'ok', messageId: sent.value.queueItemID ?? id };
      }

      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) {
        return { status: 'failed', error: 'queue item not found', reason: 'invalid' };
      }
      const item = queue[index]!;
      const sent = await promptQueuedItem(api, item);
      if (sent.status !== 'ok') return sent;
      queue = queue.filter((entry) => entry.id !== id);
      return sent;
    },

    removeFromQueue: async (queueItemId) => {
      const api = requireApi();
      if ('status' in api) return api;
      const id = queueItemId.trim();
      if (!id) {
        return { status: 'failed', error: 'queue item id required', reason: 'invalid' };
      }

      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;

      if (backend === 'server') {
        if (!serverScope) {
          const refreshed = await reloadKnownScope();
          if (refreshed.status !== 'ok') return refreshed;
        }
        const latest = serverScope?.items.find((entry) => entry.queueItemID === id);
        if (!latest || !serverScope) {
          return { status: 'failed', error: 'queue item not found', reason: 'invalid' };
        }
        const removed = await removeLynxQueueItem(api.runtimeFetch, id, {
          requestID: `request-${createId()}`,
          expectedRevision: serverScope.revision,
          expectedRowVersion: latest.rowVersion,
        });
        if (removed.status !== 'ok') {
          return {
            status: 'failed',
            error: removed.error,
            reason: removed.reason === 'unavailable' ? 'unavailable' : removed.reason === 'invalid' ? 'invalid' : 'http',
          };
        }
        await reloadKnownScope();
        return { status: 'ok' };
      }

      const before = queue.length;
      queue = queue.filter((item) => item.id !== id);
      if (queue.length === before) {
        return { status: 'failed', error: 'queue item not found', reason: 'invalid' };
      }
      return { status: 'ok' };
    },

    reorderQueue: async (activeId, overId) => {
      const api = requireApi();
      if ('status' in api) return api;
      if (!activeId.trim() || !overId.trim()) {
        return { status: 'failed', error: 'reorder ids required', reason: 'invalid' };
      }

      const backend = await ensureQueueBackend();
      if (typeof backend !== 'string') return backend;

      if (backend === 'server') {
        if (!serverScope) {
          const refreshed = await reloadKnownScope();
          if (refreshed.status !== 'ok') return refreshed;
        }
        if (!serverScope) {
          return { status: 'failed', error: 'server queue scope missing', reason: 'invalid' };
        }
        const asPrompts = lynxQueueItemsToPrompts(serverScope.items);
        const next = reorderLynxQueueChips(asPrompts, activeId, overId);
        const changed = next.length === asPrompts.length
          && next.some((item, index) => item.id !== asPrompts[index]?.id);
        if (!changed && activeId !== overId) {
          const hasActive = asPrompts.some((item) => item.id === activeId);
          const hasOver = asPrompts.some((item) => item.id === overId);
          if (!hasActive || !hasOver) {
            return { status: 'failed', error: 'reorder ids not in queue', reason: 'invalid' };
          }
        }
        const reordered = await reorderLynxQueueScope(api.runtimeFetch, serverScope.scopeID, {
          requestID: `request-${createId()}`,
          expectedRevision: serverScope.revision,
          queueItemIDs: next.map((item) => item.id),
        });
        if (reordered.status !== 'ok') {
          return {
            status: 'failed',
            error: reordered.error,
            reason: reordered.reason === 'unavailable' ? 'unavailable' : reordered.reason === 'invalid' ? 'invalid' : 'http',
          };
        }
        await reloadKnownScope();
        return { status: 'ok' };
      }

      const next = reorderLynxQueueChips(queue, activeId, overId);
      const changed = next.length === queue.length
        && next.some((item, index) => item.id !== queue[index]?.id);
      if (!changed && activeId !== overId) {
        const hasActive = queue.some((item) => item.id === activeId);
        const hasOver = queue.some((item) => item.id === overId);
        if (!hasActive || !hasOver) {
          return { status: 'failed', error: 'reorder ids not in queue', reason: 'invalid' };
        }
      }
      queue = next;
      return { status: 'ok' };
    },
  };
}
