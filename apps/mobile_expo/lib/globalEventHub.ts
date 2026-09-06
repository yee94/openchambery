/**
 * Ref-counted shared global event stream so home attention + chat share one WS/SSE.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  startGlobalEventStream,
  type EventStreamHandle,
  type EventTransportKind,
  type OpenChamberEvent,
} from '@/lib/eventStream';

export type GlobalEventListener = (event: OpenChamberEvent) => void;
export type GlobalTransportListener = (kind: EventTransportKind | null) => void;

type HubKey = string;

const runtimeKey = (runtime: ActiveRuntime): HubKey => {
  const transport =
    runtime.transport.kind === 'direct'
      ? `direct:${runtime.transport.url}`
      : `relay:${runtime.transport.relay.relayUrl}:${runtime.transport.relay.serverId}`;
  return `${runtime.connectionId}::${transport}`;
};

type Hub = {
  key: HubKey;
  runtime: ActiveRuntime;
  handle: EventStreamHandle;
  eventListeners: Set<GlobalEventListener>;
  transportListeners: Set<GlobalTransportListener>;
  transport: EventTransportKind | null;
};

let hub: Hub | null = null;

const stopHub = () => {
  if (!hub) return;
  hub.handle.cleanup();
  hub = null;
};

const ensureHub = (runtime: ActiveRuntime): Hub => {
  const key = runtimeKey(runtime);
  if (hub && hub.key === key) return hub;
  stopHub();
  const eventListeners = new Set<GlobalEventListener>();
  const transportListeners = new Set<GlobalTransportListener>();
  const next: Hub = {
    key,
    runtime,
    eventListeners,
    transportListeners,
    transport: null,
    handle: null as unknown as EventStreamHandle,
  };
  next.handle = startGlobalEventStream(runtime, {
    onEvent: (event) => {
      for (const listener of eventListeners) listener(event);
    },
    onTransport: (kind) => {
      next.transport = kind;
      for (const listener of transportListeners) listener(kind);
    },
  });
  hub = next;
  return next;
};

/**
 * Subscribe to the shared global event stream for this runtime.
 * Last unsubscriber stops the underlying transport.
 */
export const subscribeGlobalEvents = (
  runtime: ActiveRuntime,
  listener: GlobalEventListener,
  options?: { onTransport?: GlobalTransportListener },
): (() => void) => {
  const current = ensureHub(runtime);
  current.eventListeners.add(listener);
  if (options?.onTransport) {
    current.transportListeners.add(options.onTransport);
    options.onTransport(current.transport);
  }
  return () => {
    current.eventListeners.delete(listener);
    if (options?.onTransport) current.transportListeners.delete(options.onTransport);
    if (hub === current && current.eventListeners.size === 0) {
      stopHub();
    }
  };
};

/** Test helper — tear down any live hub. */
export const resetGlobalEventHub = (): void => {
  stopHub();
};
