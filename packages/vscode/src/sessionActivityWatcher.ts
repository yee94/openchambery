import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeManager } from './opencode';
import {
  noteQuestionAutoDelegateDirectory,
  processQuestionAutoDelegateEvent,
  reconcileQuestionAutoDelegate,
  startQuestionAutoDelegateRuntime,
  stopQuestionAutoDelegateRuntime,
} from './question-auto-delegate-runtime';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

type MessageSink = { postMessage: (message: unknown) => void };

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
/** Primary chat sink; additional sinks register via addGlobalEventMessageSink. */
let chatViewProvider: MessageSink | null = null;
const messageSinks = new Set<MessageSink>();
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;
let activeManager: OpenCodeManager | null = null;
/**
 * Bound OpenCode endpoint identity for QAD lifetime.
 * Same-endpoint disconnect keeps core/pause/uncertain; a different URL disposes.
 */
let boundQuestionAutoDelegateEndpoint: string | null = null;

const normalizeEndpointKey = (apiUrl: string | null | undefined): string | null => {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    // Managed OpenCode restarts rotate the loopback port — treat as one upstream.
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return `loopback:${url.protocol}`;
    }
    // External host identity (host:port); pathname ignored.
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/+$/, '');
  }
};

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const broadcastToSinks = (message: unknown): void => {
  const targets = new Set<MessageSink>();
  if (chatViewProvider) targets.add(chatViewProvider);
  for (const sink of messageSinks) targets.add(sink);
  for (const sink of targets) {
    try {
      sink.postMessage(message);
    } catch {
      // Closed webviews must not break host-side activity tracking.
    }
  }
};

/**
 * Register an extension-level webview (or other sink) for host push events
 * (session-activity, question-auto-delegate tips, etc.).
 */
export const addGlobalEventMessageSink = (sink: MessageSink): (() => void) => {
  messageSinks.add(sink);
  return () => {
    messageSinks.delete(sink);
  };
};

const unwrapGlobalEventPayload = (eventData: unknown): Record<string, unknown> | null => {
  if (!eventData || typeof eventData !== 'object') {
    return null;
  }

  const record = eventData as { payload?: unknown };
  if (record.payload && typeof record.payload === 'object') {
    return record.payload as Record<string, unknown>;
  }

  return eventData as Record<string, unknown>;
};

/**
 * Preserve the authoritative directory from the global envelope when present.
 * OpenCode multi-directory hubs stamp `directory` on the envelope; payload
 * properties may also carry it for question/session events.
 */
const extractDirectoryHint = (
  rawEvent: unknown,
  payload: Record<string, unknown> | null,
): string => {
  const asDir = (value: unknown): string =>
    (typeof value === 'string' && value.trim() && value.trim() !== 'global' ? value.trim() : '');

  if (rawEvent && typeof rawEvent === 'object') {
    const record = rawEvent as Record<string, unknown>;
    const fromEnvelope = asDir(record.directory);
    if (fromEnvelope) return fromEnvelope;
    // Some SDK wrappers nest the OpenCode event under `.payload` while keeping
    // directory on the outer envelope or on an intermediate record.
    if (record.payload && typeof record.payload === 'object') {
      const nested = record.payload as Record<string, unknown>;
      const nestedDir = asDir(nested.directory);
      if (nestedDir) return nestedDir;
    }
  }

  if (!payload) return '';
  const fromPayload = asDir(payload.directory);
  if (fromPayload) return fromPayload;
  const properties =
    payload.properties && typeof payload.properties === 'object'
      ? (payload.properties as Record<string, unknown>)
      : null;
  if (properties) {
    const fromProps = asDir(properties.directory);
    if (fromProps) return fromProps;
    const info =
      properties.info && typeof properties.info === 'object'
        ? (properties.info as Record<string, unknown>)
        : null;
    if (info) {
      const fromInfo = asDir(info.directory);
      if (fromInfo) return fromInfo;
    }
  }
  return '';
};

const reconcileSessionActivityFromStatus = async (manager: OpenCodeManager): Promise<void> => {
  const baseUrl = manager.getApiUrl();
  if (!baseUrl) {
    return;
  }

  const url = new URL('/session/status', baseUrl);
  const response = await fetch(url.toString(), {
    headers: manager.getOpenCodeAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`session status fetch failed (${response.status})`);
  }

  const statuses = await response.json() as Record<string, { type?: string }>;
  const knownSessionIds = new Set(Object.keys(statuses || {}));

  for (const [sessionId, data] of Object.entries(statuses || {})) {
    const type = typeof data?.type === 'string' ? data.type : 'idle';
    const phase: ActivityPhase = type === 'busy' || type === 'retry' ? 'busy' : 'idle';
    setSessionActivityPhase(sessionId, phase);
  }

  // Drop stale in-memory activity entries not present in authoritative status.
  for (const sessionId of Array.from(sessionActivityPhases.keys())) {
    if (!knownSessionIds.has(sessionId)) {
      setSessionActivityPhase(sessionId, 'idle');
    }
  }
};

const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase): void => {
  if (!sessionId) return;

  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return;

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  broadcastToSinks({
    type: 'openchamber:session-activity',
    properties: {
      sessionId,
      phase,
    },
  });

  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        broadcastToSinks({
          type: 'openchamber:session-activity',
          properties: {
            sessionId,
            phase: 'idle',
          },
        });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }
};

export const getSessionActivitySnapshot = (): Record<string, { type: ActivityPhase }> => {
  const snapshot: Record<string, { type: ActivityPhase }> = {};
  for (const [sessionId, data] of sessionActivityPhases.entries()) {
    snapshot[sessionId] = { type: data.phase };
  }
  return snapshot;
};

const deriveSessionActivity = (payload: Record<string, unknown>): SessionActivity | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = payload.type as string;
  const properties = (payload.properties ?? payload) as Record<string, unknown>;

  if (type === 'session.status') {
    const status = properties?.status as Record<string, unknown> | undefined;
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    const statusType = (status?.type ?? info?.type) as string;

    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof statusType === 'string') {
      const phase = statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
      return { sessionId, phase };
    }
  }

  if (type === 'message.updated' || type === 'message.part.updated' || type === 'message.part.delta') {
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId) as string;
    const role = info?.role as string;
    const finish = info?.finish as string;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle') {
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'idle' };
    }
  }

  return null;
};

const waitForOpenCodePort = async (manager: OpenCodeManager, timeoutMs = 30000): Promise<number | null> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const apiUrl = manager.getApiUrl();
    if (apiUrl) {
      try {
        const url = new URL(apiUrl);
        if (url.port) {
          return parseInt(url.port, 10);
        }
      } catch {
        // ignore
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
};

const ingestGlobalEvent = (rawEvent: unknown): void => {
  const payload = unwrapGlobalEventPayload(
    rawEvent && typeof rawEvent === 'object' && 'payload' in (rawEvent as object)
      ? (rawEvent as { payload?: unknown }).payload ?? rawEvent
      : rawEvent,
  );
  const directoryHint = extractDirectoryHint(rawEvent, payload);
  if (directoryHint) {
    noteQuestionAutoDelegateDirectory(directoryHint);
  }

  if (payload) {
    // Feed the full OpenCode event (type + properties) to auto-delegate so
    // question.asked / replied / rejected and session lineage stay authoritative
    // even when no webview is open (including background subagent sessions).
    processQuestionAutoDelegateEvent(payload, directoryHint);

    const activity = deriveSessionActivity(payload);
    if (activity) {
      setSessionActivityPhase(activity.sessionId, activity.phase);
    }
  }
};

/**
 * Abort the global SSE loop without disposing question-auto-delegate core.
 * Same-upstream disconnect must retain pause/claim/uncertain until reconnect
 * reconcile (or a real endpoint switch / deactivate dispose).
 */
export const suspendGlobalEventWatcher = (): void => {
  globalEventWatcherStartToken += 1;
  clearGlobalEventWatcherRetry();

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
  // Keep chatViewProvider, messageSinks, activeManager, QAD core, and activity map.
};

export const startGlobalEventWatcher = async (
  manager: OpenCodeManager,
  provider?: MessageSink | null,
): Promise<void> => {
  if (provider) {
    chatViewProvider = provider;
  }

  activeManager = manager;
  const nextEndpoint = normalizeEndpointKey(manager.getApiUrl());
  if (
    boundQuestionAutoDelegateEndpoint
    && nextEndpoint
    && boundQuestionAutoDelegateEndpoint !== nextEndpoint
  ) {
    // Real OpenCode endpoint switch — drop prior host authority cleanly.
    stopQuestionAutoDelegateRuntime();
    boundQuestionAutoDelegateEndpoint = null;
  }
  if (nextEndpoint) {
    boundQuestionAutoDelegateEndpoint = nextEndpoint;
  }

  if (globalEventWatcherAbortController) {
    // Already running — still (re)bind manager + QAD for same-endpoint refresh.
    startQuestionAutoDelegateRuntime(manager);
    return;
  }

  const startToken = ++globalEventWatcherStartToken;
  clearGlobalEventWatcherRetry();

  // Extension-host singleton: start QAD before the SSE loop so pending reconcile
  // and timers are live even if the stream is slow to connect.
  startQuestionAutoDelegateRuntime(manager);

  const port = await waitForOpenCodePort(manager);
  if (startToken !== globalEventWatcherStartToken) {
    return;
  }
  if (!port) {
    console.warn('[VSCode:Activity] OpenCode port unavailable; will retry');
    globalEventWatcherRetryTimer = setTimeout(() => {
      globalEventWatcherRetryTimer = null;
      if (startToken === globalEventWatcherStartToken) {
        void startGlobalEventWatcher(manager, provider);
      }
    }, 2000);
    return;
  }

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;

  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      attempt += 1;

      try {
        const baseUrl = manager.getApiUrl();
        if (!baseUrl) {
          throw new Error('OpenCode API URL not available');
        }

        const client = createOpencodeClient({
          baseUrl,
          headers: manager.getOpenCodeAuthHeaders(),
        });
        try {
          await reconcileSessionActivityFromStatus(manager);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] session status reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }

        // Connection (re)established — recover pending questions across
        // workspace / worktrees / observed directories (subagents included).
        void reconcileQuestionAutoDelegate().catch((error) => {
          console.warn(
            '[VSCode:QAD] reconcile on connect failed',
            error instanceof Error ? error.message : error,
          );
        });

        const result = await client.global.event({
          signal,
          sseMaxRetryAttempts: 0,
        });

        console.log('[VSCode:Activity] connected');
        // Stream accepted — treat as a fresh connect tip for pending recovery.
        void reconcileQuestionAutoDelegate().catch(() => {
          // already logged above path; silent here
        });

        for await (const event of result.stream) {
          ingestGlobalEvent(event);

          if (signal.aborted) {
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[VSCode:Activity] disconnected', error instanceof Error ? error.message : error);
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  };

  void run();
};

export const stopGlobalEventWatcher = (): void => {
  globalEventWatcherStartToken += 1;
  clearGlobalEventWatcherRetry();

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
  chatViewProvider = null;
  activeManager = null;
  boundQuestionAutoDelegateEndpoint = null;

  // Full dispose: extension deactivate or intentional teardown only.
  // Transient OpenCode disconnect uses suspendGlobalEventWatcher instead.
  stopQuestionAutoDelegateRuntime();

  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  sessionActivityPhases.clear();
};

export const setChatViewProvider = (provider: MessageSink | null): void => {
  chatViewProvider = provider;
};

/** Test seam: feed a raw global event without an OpenCode stream. */
export const __ingestGlobalEventForTests = (rawEvent: unknown): void => {
  ingestGlobalEvent(rawEvent);
};

export const __getActiveManagerForTests = (): OpenCodeManager | null => activeManager;

export const __getBoundQuestionAutoDelegateEndpointForTests = (): string | null =>
  boundQuestionAutoDelegateEndpoint;

export const __normalizeEndpointKeyForTests = normalizeEndpointKey;
