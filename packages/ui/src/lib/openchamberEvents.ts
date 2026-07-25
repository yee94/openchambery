import { consumeRuntimeSse } from './runtime-sse';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

type EventStreamReadyEvent = { type: 'event-stream-ready' };
type WorktreeTopologyChangedEvent = {
  type: 'worktree-topology-changed';
  projectDirectory: string;
  directory: string;
  operation: 'added' | 'removed';
  occurredAt: number;
};
type WorktreeBootstrapStatusEvent = {
  type: 'worktree-bootstrap-status';
  directory: string;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  updatedAt: number;
};
/** Session-index SQLite revision tip — clients GET /api/openchamber/session-index. */
type SessionIndexChangedEvent = {
  type: 'session-index-changed';
  revision: number;
  sync?: { active: boolean; enriching: boolean };
  occurredAt: number;
};
/** Message-queue revision tip — clients GET /api/openchamber/message-queue. */
type MessageQueueChangedEvent = {
  type: 'message-queue-changed';
  revision: number;
  occurredAt: number;
};
/** Assistants SQLite revision tip — clients GET the authoritative snapshot/history. */
type AssistantsChangedEvent = {
  type: 'assistants-changed';
  revision: number;
  occurredAt: number;
};
type OpenChamberEvent =
  | ScheduledTaskRanEvent
  | EventStreamReadyEvent
  | WorktreeTopologyChangedEvent
  | WorktreeBootstrapStatusEvent
  | SessionIndexChangedEvent
  | MessageQueueChangedEvent
  | AssistantsChangedEvent;
type Listener = (event: OpenChamberEvent) => void;

type ConnectionAttempt = { controller: AbortController };

let attempt: ConnectionAttempt | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupAttempt = () => {
  clearHeartbeatTimer();
  const currentAttempt = attempt;
  attempt = null;
  currentAttempt?.controller.abort();
};

const resetHeartbeatTimer = (expectedAttempt: ConnectionAttempt) => {
  clearHeartbeatTimer();
  if (listeners.size === 0 || attempt !== expectedAttempt) {
    return;
  }
  const timer = setTimeout(() => {
    if (attempt !== expectedAttempt || heartbeatTimer !== timer) return;
    heartbeatTimer = null;
    cleanupAttempt();
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const parseEnvelope = (raw: string): { type: string; properties: unknown } | null => {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const type = typeof parsed?.type === 'string' ? parsed.type : '';
    const properties = parsed?.properties;
    if (!type) {
      return null;
    }
    return { type, properties };
  } catch {
    return null;
  }
};

export const parseOpenchamberEventEnvelope = (envelope: { type: string; properties: unknown }): OpenChamberEvent | null => {
  if (envelope.type === 'openchamber:event-stream-ready') {
    return envelope.properties === undefined || envelope.properties === null || (typeof envelope.properties === 'object' && !Array.isArray(envelope.properties))
      ? { type: 'event-stream-ready' }
      : null;
  }

  if (envelope.type === 'openchamber:heartbeat') {
    return null;
  }

  const parsed = envelope.properties && typeof envelope.properties === 'object' && !Array.isArray(envelope.properties)
    ? envelope.properties as Record<string, unknown>
    : null;

  if (envelope.type === 'openchamber:worktree-topology-changed') {
    const projectDirectory = typeof parsed?.projectDirectory === 'string' ? parsed.projectDirectory.trim() : '';
    const directory = typeof parsed?.directory === 'string' ? parsed.directory.trim() : '';
    const operation = parsed?.operation;
    const occurredAt = parsed?.occurredAt;
    if (!projectDirectory || !directory || (operation !== 'added' && operation !== 'removed') || typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    return { type: 'worktree-topology-changed', projectDirectory, directory, operation, occurredAt };
  }

  if (envelope.type === 'openchamber:worktree-bootstrap-status') {
    const directory = typeof parsed?.directory === 'string' ? parsed.directory.trim() : '';
    const status = parsed?.status;
    const updatedAt = parsed?.updatedAt;
    const error = typeof parsed?.error === 'string' && parsed.error.trim().length > 0 ? parsed.error.trim() : null;
    if (!directory || (status !== 'pending' && status !== 'ready' && status !== 'failed')) return null;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
    return { type: 'worktree-bootstrap-status', directory, status, error, updatedAt };
  }

  if (envelope.type === 'openchamber:session-index-changed') {
    const revision = parsed?.revision;
    const occurredAt = parsed?.occurredAt;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    const syncRaw = parsed?.sync && typeof parsed.sync === 'object' && !Array.isArray(parsed.sync)
      ? parsed.sync as Record<string, unknown>
      : null;
    return {
      type: 'session-index-changed',
      revision,
      occurredAt,
      ...(syncRaw
        ? {
            sync: {
              active: syncRaw.active === true,
              enriching: syncRaw.enriching === true,
            },
          }
        : {}),
    };
  }

  if (envelope.type === 'openchamber:message-queue-changed') {
    const revision = parsed?.revision;
    const occurredAt = parsed?.occurredAt;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    return { type: 'message-queue-changed', revision, occurredAt };
  }

  if (envelope.type === 'openchamber:assistants-changed') {
    const revision = parsed?.revision;
    const occurredAt = parsed?.occurredAt;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    return { type: 'assistants-changed', revision, occurredAt };
  }

  if (envelope.type !== 'openchamber:scheduled-task-ran') {
    return null;
  }

  const projectId = typeof parsed?.projectId === 'string' ? parsed.projectId : '';
  const taskId = typeof parsed?.taskId === 'string' ? parsed.taskId : '';
  const ranAt = typeof parsed?.ranAt === 'number' ? parsed.ranAt : Date.now();
  const rawStatus = parsed?.status;
  const status = rawStatus === 'running' || rawStatus === 'error' ? rawStatus : 'success';
  if (!projectId || !taskId) {
    return null;
  }

  const nextEvent: ScheduledTaskRanEvent = {
    type: 'scheduled-task-ran',
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0 ? { sessionId: parsed.sessionId } : {}),
  };
  return nextEvent;
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  const nextEvent = parseOpenchamberEventEnvelope(envelope);
  if (!nextEvent) return;
  if (nextEvent.type === 'event-stream-ready') reconnectAttempt = 0;
  for (const listener of listeners) {
    try {
      listener(nextEvent);
    } catch {
      // One consumer cannot disrupt the shared event transport.
    }
  }
};

const connect = () => {
  if (typeof window === 'undefined' || listeners.size === 0) {
    return;
  }
  if (attempt) return;

  const nextAttempt: ConnectionAttempt = { controller: new AbortController() };
  attempt = nextAttempt;
  void consumeRuntimeSse('/api/openchamber/events', {
    signal: nextAttempt.controller.signal,
    onOpen: () => {
      if (attempt !== nextAttempt) return;
      resetHeartbeatTimer(nextAttempt);
    },
    onActivity: () => {
      if (attempt !== nextAttempt) return;
      resetHeartbeatTimer(nextAttempt);
    },
    onMessage: (data) => {
      if (attempt !== nextAttempt) return;
      const envelope = parseEnvelope(data);
      if (envelope) dispatchFromEnvelope(envelope);
    },
  }).then(
    () => {
      if (attempt !== nextAttempt) return;
      attempt = null;
      clearHeartbeatTimer();
      scheduleReconnect();
    },
    () => {
      if (attempt !== nextAttempt) return;
      attempt = null;
      clearHeartbeatTimer();
      if (!nextAttempt.controller.signal.aborted) scheduleReconnect();
    },
  );
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || typeof window === 'undefined') return;
  runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupAttempt();
    reconnectAttempt = 0;
    connect();
  });
};

const cleanupRuntimeChangeSubscription = () => {
  runtimeChangeUnsubscribe?.();
  runtimeChangeUnsubscribe = null;
};

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupAttempt();
      cleanupRuntimeChangeSubscription();
    }
  };
};
