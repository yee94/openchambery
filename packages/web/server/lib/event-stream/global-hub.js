import { summarizeOutboundEventPayload } from './diff-summary.js';
import { createUpstreamSseReader } from './upstream-reader.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const RUNTIME_KEY = /^[a-f0-9]{64}$/;

const runtimeFenceToken = (runtimeKey, generation) => `${runtimeKey}:${generation}`;

const captureRuntimeIdentity = (provider, generation) => {
  try {
    const identity = provider?.();
    const runtimeKey = identity?.runtimeKey ?? identity?.key;
    if (typeof runtimeKey !== 'string' || !RUNTIME_KEY.test(runtimeKey) || !Number.isSafeInteger(generation) || generation < 0) {
      return null;
    }
    return { runtimeKey, generation, token: runtimeFenceToken(runtimeKey, generation) };
  } catch {
    return null;
  }
};

export function confirmMessageQueueEvent(messageQueueService, event) {
  const runtime = event?.runtimeIdentity;
  if (!messageQueueService || !runtime || typeof runtime.runtimeKey !== 'string' || !RUNTIME_KEY.test(runtime.runtimeKey) || !Number.isSafeInteger(runtime.generation)
    || runtime.generation < 0 || runtime.token !== runtimeFenceToken(runtime.runtimeKey, runtime.generation)) {
    return false;
  }

  try {
    const authority = messageQueueService.getAuthority({ runtimeKey: runtime.runtimeKey });
    if (!['active', 'paused'].includes(authority?.authority) || !Number.isSafeInteger(authority.generation) || authority.generation < 0) {
      return false;
    }

    const payload = event?.payload?.payload ?? event?.payload;
    const directory = event?.directory;
    const info = payload?.type === 'message.updated' && payload.properties?.info?.role === 'user'
      ? payload.properties.info
      : null;
    if (!directory || !info?.sessionID || !info?.id) {
      return false;
    }

    void messageQueueService.confirmByMessage({
      runtimeKey: runtime.runtimeKey,
      directory,
      sessionID: info.sessionID,
      messageID: info.id,
      source: 'event',
    });
    return true;
  } catch {
    return false;
  }
}

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  getRuntimeIdentity = null,
  /**
   * Optional Host authority projection for session.created / session.updated
   * (and GlobalEvent wrap). Applied before fan-out and replay so browser and
   * server subscribers share the same archive view. Must be sync and cheap.
   * @type {((payload: unknown) => unknown) | null}
   */
  projectOutboundSessionPayload = null,
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;
  let runtimeIdentityProvider = getRuntimeIdentity;
  let runtimeConnectionGeneration = 0;
  let activeConnectionRuntimeIdentity = null;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  let sessionPayloadProjector = typeof projectOutboundSessionPayload === 'function'
    ? projectOutboundSessionPayload
    : null;

  /**
   * Diff-summarize only. Host archive projection is applied at fan-out and
   * replayAfter time against the *current* committed store — never baked into
   * the replay buffer (stale archive stamps must not stick after Host writes).
   */
  const normalizeEvent = ({ envelope, payload, connectionContext }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = typeof envelope?.eventId === 'string' && envelope.eventId.length > 0 ? envelope.eventId : undefined;
    const outboundPayload = summarizeOutboundEventPayload(payload);
    return {
      envelope,
      payload: outboundPayload,
      directory,
      eventId,
      ...(connectionContext ? { runtimeIdentity: connectionContext } : {}),
    };
  };

  const projectForOutbound = (payload) => {
    if (typeof sessionPayloadProjector !== 'function') return payload;
    try {
      const projected = sessionPayloadProjector(payload);
      // null = Host not ready; suppress this lifecycle frame.
      if (projected == null) return null;
      return projected;
    } catch (error) {
      console.warn('[event-stream] session payload projection failed:', error?.message ?? error);
      return payload;
    }
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          // v2 serves the event stream at `/api/event`; `/api/global/event` is gone.
          return new URL(buildOpenCodeUrl('/event', ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        const runtimeIdentity = captureRuntimeIdentity(runtimeIdentityProvider, ++runtimeConnectionGeneration);
        activeConnectionRuntimeIdentity = runtimeIdentity;
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
        return runtimeIdentity;
      },
      onDisconnect({ reason }) {
        connected = false;
        activeConnectionRuntimeIdentity = null;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        // The queue runtime is initialized after the shared watcher can already
        // be connected. Late-bind the first available identity to that existing
        // connection, then keep it fenced for the rest of the connection so a
        // later runtime switch cannot relabel buffered events.
        if (!event?.connectionContext && !activeConnectionRuntimeIdentity) {
          activeConnectionRuntimeIdentity = captureRuntimeIdentity(runtimeIdentityProvider, runtimeConnectionGeneration);
        }
        const normalized = normalizeEvent({
          ...event,
          connectionContext: event?.connectionContext ?? activeConnectionRuntimeIdentity,
        });
        // Buffer the unprojected payload so reconnect replay uses current Host authority.
        if (normalized.eventId) {
          replay.push(normalized);
          if (replay.length > replayLimit) {
            replay.splice(0, replay.length - replayLimit);
          }
        }

        const projectedPayload = projectForOutbound(normalized.payload);
        if (projectedPayload == null) return;
        const outbound = projectedPayload === normalized.payload
          ? normalized
          : { ...normalized, payload: projectedPayload };

        for (const subscriber of Array.from(eventSubscribers)) {
          notifySubscriber('event', subscriber, outbound);
        }
      },
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
  };

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    subscribeEvent(subscriber) {
      eventSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
      };
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    replayAfter(eventId) {
      if (!eventId) {
        return [];
      }

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      if (index === -1) return [];
      // Re-project with current committed Host authority at replay time.
      const out = [];
      for (const entry of replay.slice(index + 1)) {
        const projectedPayload = projectForOutbound(entry.payload);
        if (projectedPayload == null) continue;
        out.push(projectedPayload === entry.payload ? entry : { ...entry, payload: projectedPayload });
      }
      return out;
    },
    setRuntimeIdentityProvider(provider) {
      runtimeIdentityProvider = typeof provider === 'function' ? provider : null;
    },
    setSessionPayloadProjector(projector) {
      sessionPayloadProjector = typeof projector === 'function' ? projector : null;
    },
  };
}
