import { OpenCode } from '@opencode-ai/client';
import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let chatViewProvider: { postMessage: (message: unknown) => void } | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const unwrapV2Event = (eventData: unknown): Record<string, unknown> | null => {
  if (!eventData || typeof eventData !== 'object') {
    return null;
  }

  return eventData as Record<string, unknown>;
};

const reconcileSessionActivityFromActive = async (
  client: ReturnType<typeof OpenCode.make>,
): Promise<void> => {
  const active = await client.session.active();
  const statuses = active && typeof active === 'object' ? active : {};
  const knownSessionIds = new Set(Object.keys(statuses));

  for (const [sessionId, data] of Object.entries(statuses)) {
    const type = data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string'
      ? (data as { type: string }).type
      : '';
    const phase: ActivityPhase = type === 'running' || type === 'busy' || type === 'retry' ? 'busy' : 'idle';
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

  chatViewProvider?.postMessage({
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
        chatViewProvider?.postMessage({
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

const deriveSessionActivity = (event: Record<string, unknown>): SessionActivity | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const type = event.type as string;
  const data = (event.data && typeof event.data === 'object' ? event.data : event) as Record<string, unknown>;
  const sessionId = (data.sessionID ?? data.sessionId) as string;

  if (type === 'session.status') {
    const status = data.status as Record<string, unknown> | undefined;
    const statusType = status?.type as string;
    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof statusType === 'string') {
      const phase = statusType === 'busy' || statusType === 'retry' || statusType === 'running' ? 'busy' : 'idle';
      return { sessionId, phase };
    }
  }

  if (type === 'session.execution.started' || type === 'session.retry.scheduled') {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'busy' };
    }
  }

  if (
    type === 'session.execution.succeeded'
    || type === 'session.execution.failed'
    || type === 'session.execution.interrupted'
  ) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle' || type === 'session.deleted') {
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

export const startGlobalEventWatcher = async (
  manager: OpenCodeManager,
  provider: { postMessage: (message: unknown) => void }
): Promise<void> => {
  if (globalEventWatcherAbortController) {
    return;
  }

  const startToken = ++globalEventWatcherStartToken;
  clearGlobalEventWatcherRetry();
  chatViewProvider = provider;

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

        const client = OpenCode.make({
          baseUrl,
          headers: manager.getOpenCodeAuthHeaders(),
          fetch: globalThis.fetch,
        });
        try {
          await reconcileSessionActivityFromActive(client);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] session status reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }
        const events = client.event.subscribe({ signal });

        console.log('[VSCode:Activity] connected');

        for await (const event of events) {
          const payload = unwrapV2Event(event);
          if (payload) {
            const activity = deriveSessionActivity(payload);
            if (activity) {
              setSessionActivityPhase(activity.sessionId, activity.phase);
            }
          }

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

  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  sessionActivityPhases.clear();
};

export const setChatViewProvider = (provider: { postMessage: (message: unknown) => void } | null): void => {
  chatViewProvider = provider;
};
