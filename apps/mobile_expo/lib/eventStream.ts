/**
 * Global event transport for Expo Chat.
 * Prefer /api/global/event/ws → SSE fallback → poll only as reconnect fallback.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import { createRelayTunnelClient, type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

export type EventTransportKind = 'ws' | 'sse' | 'poll';

export type OpenChamberEvent = {
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

export type EventStreamHandlers = {
  onEvent?: (event: OpenChamberEvent) => void;
  onTransport?: (kind: EventTransportKind) => void;
  onDisconnect?: (reason: string) => void;
  onReconnect?: () => void;
};

export type EventStreamOptions = {
  /** Force a transport (tests). Default: auto (ws → sse → poll). */
  transport?: 'auto' | EventTransportKind;
  pollIntervalMs?: number;
  wsReadyTimeoutMs?: number;
  /** Injectable WS factory for tests. */
  openWs?: (url: string) => WebSocketLike;
  /** Injectable SSE POST/GET runner for tests. */
  openSse?: (args: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    onLine: (line: string) => void;
  }) => Promise<void>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
};

export type EventStreamHandle = {
  cleanup: () => void;
  getTransport: () => EventTransportKind | null;
};

const WS_OPEN = 1;

const defaultWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const parseEventPayload = (raw: unknown): OpenChamberEvent | null => {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string') return record as OpenChamberEvent;
  if (record.payload && typeof record.payload === 'object') {
    const inner = record.payload as Record<string, unknown>;
    if (typeof inner.type === 'string') return inner as OpenChamberEvent;
  }
  if (record.data && typeof record.data === 'object') {
    const inner = record.data as Record<string, unknown>;
    if (typeof inner.type === 'string') return inner as OpenChamberEvent;
  }
  return null;
};

const bearerHeaders = (active: ActiveRuntime): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (active.clientToken) headers.Authorization = `Bearer ${active.clientToken}`;
  return headers;
};

const directHttpBase = (active: ActiveRuntime): string | null => {
  if (active.transport.kind !== 'direct') return null;
  return active.transport.url.replace(/\/+$/, '');
};

const toWsUrl = (httpBase: string, path: string): string => {
  const url = new URL(path, httpBase.endsWith('/') ? httpBase : `${httpBase}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const ensureRelayTunnel = (active: ActiveRuntime) => {
  if (active.transport.kind !== 'relay') return null;
  let tunnel = active.transport.tunnel;
  if (!tunnel) {
    tunnel = createRelayTunnelClient({
      relayUrl: active.transport.relay.relayUrl,
      serverId: active.transport.relay.serverId,
      hostEncPubJwk: active.transport.relay.hostEncPubJwk,
      ...(active.transport.relay.grant ? { grant: active.transport.relay.grant } : {}),
    });
    active.transport.tunnel = tunnel;
  }
  return tunnel;
};

async function runSseFetch(args: {
  active: ActiveRuntime;
  path: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  openSse?: EventStreamOptions['openSse'];
}): Promise<void> {
  if (args.openSse) {
    const base = directHttpBase(args.active) ?? 'http://local';
    await args.openSse({
      url: `${base}${args.path}`,
      headers: bearerHeaders(args.active),
      signal: args.signal,
      onLine: args.onLine,
    });
    return;
  }

  const response = await openchamberFetch(args.active, args.path, {
    method: 'GET',
    headers: bearerHeaders(args.active),
    signal: args.signal,
  });
  if (!response.ok) {
    throw new Error(`sse failed (${response.status})`);
  }
  // openchamberFetch only exposes json/text — for foundation SSE we read full text
  // and split. True streaming needs a raw body; poll fallback covers reconnect.
  const text = await response.text();
  for (const line of text.split(/\r?\n/)) {
    if (args.signal.aborted) return;
    args.onLine(line);
  }
}

/**
 * Start the global event stream. Auto prefers WS, falls back to SSE,
 * and uses poll only while reconnecting after both fail.
 */
export const startGlobalEventStream = (
  active: ActiveRuntime,
  handlers: EventStreamHandlers,
  options: EventStreamOptions = {},
): EventStreamHandle => {
  const abort = new AbortController();
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 2_500;
  const wsReadyTimeoutMs = options.wsReadyTimeoutMs ?? 2_000;

  let current: EventTransportKind | null = null;
  let wsFallbackUntil = 0;
  let lastEventId: string | null = null;

  const setTransport = (kind: EventTransportKind) => {
    current = kind;
    handlers.onTransport?.(kind);
  };

  const publish = (event: OpenChamberEvent) => {
    const props = event.properties;
    const rawId = (event as Record<string, unknown>).id;
    const id =
      (typeof rawId === 'string' && rawId) ||
      (props && typeof props.id === 'string' ? props.id : null);
    if (id) lastEventId = id;
    handlers.onEvent?.(event);
  };

  const ingestLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    const event = parseEventPayload(data);
    if (event) publish(event);
  };

  const openDirectWs = (url: string): WebSocketLike => {
    if (options.openWs) return options.openWs(url);
    return new WebSocket(url) as unknown as WebSocketLike;
  };

  const tryWs = async (signal: AbortSignal): Promise<boolean> => {
    if (options.transport === 'sse' || options.transport === 'poll') return false;
    if (now() < wsFallbackUntil && options.transport !== 'ws') return false;

    const path =
      lastEventId && lastEventId.length > 0
        ? `/api/global/event/ws?lastEventId=${encodeURIComponent(lastEventId)}`
        : '/api/global/event/ws';

    let socket: WebSocketLike | RelayTunnelWebSocket | null = null;

    try {
      if (active.transport.kind === 'relay') {
        const tunnel = ensureRelayTunnel(active);
        if (!tunnel) return false;
        socket = tunnel.openWebSocket(path);
      } else {
        const base = directHttpBase(active);
        if (!base) return false;
        socket = openDirectWs(toWsUrl(base, path));
      }
    } catch {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(ok);
      };

      const timer = setTimeout(() => {
        try {
          socket?.close();
        } catch {
          // ignore
        }
        wsFallbackUntil = now() + 60_000;
        finish(false);
      }, wsReadyTimeoutMs);

      const onAbort = () => {
        try {
          socket?.close();
        } catch {
          // ignore
        }
        finish(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      socket!.onopen = () => {
        setTransport('ws');
        finish(true);
      };
      socket!.onmessage = (ev: { data: unknown }) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
        for (const line of data.split(/\r?\n/)) ingestLine(line);
      };
      socket!.onerror = () => {
        wsFallbackUntil = now() + 60_000;
        if (!settled) finish(false);
        else handlers.onDisconnect?.('ws_error');
      };
      socket!.onclose = () => {
        if (!settled) {
          wsFallbackUntil = now() + 60_000;
          finish(false);
        } else if (!signal.aborted) {
          handlers.onDisconnect?.('ws_close');
        }
      };
    }).then(async (opened) => {
      if (!opened || signal.aborted) return false;
      // Hold until abort — socket handlers already wired.
      try {
        await wait(2_147_483_647, signal);
      } catch {
        try {
          socket?.close();
        } catch {
          // ignore
        }
      }
      return true;
    });
  };

  const trySse = async (signal: AbortSignal): Promise<boolean> => {
    if (options.transport === 'ws' || options.transport === 'poll') return false;
    const path =
      lastEventId && lastEventId.length > 0
        ? `/api/global/event?lastEventId=${encodeURIComponent(lastEventId)}`
        : '/api/global/event';
    try {
      setTransport('sse');
      await runSseFetch({
        active,
        path,
        signal,
        onLine: ingestLine,
        openSse: options.openSse,
      });
      return true;
    } catch {
      return false;
    }
  };

  const pollOnce = async (signal: AbortSignal): Promise<void> => {
    setTransport('poll');
    const path =
      lastEventId && lastEventId.length > 0
        ? `/api/global/event?lastEventId=${encodeURIComponent(lastEventId)}&poll=1`
        : '/api/global/event?poll=1';
    try {
      const response = await openchamberFetch(active, path, {
        method: 'GET',
        headers: { Accept: 'application/json', ...bearerHeaders(active) },
        signal,
      });
      if (!response.ok) return;
      const payload = await response.json();
      const events = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { events?: unknown })?.events)
          ? (payload as { events: unknown[] }).events
          : payload
            ? [payload]
            : [];
      for (const entry of events) {
        const event = parseEventPayload(entry);
        if (event) publish(event);
      }
    } catch {
      // ignore poll errors; loop retries
    }
  };

  const loop = async () => {
    const signal = abort.signal;
    while (!signal.aborted) {
      let connected = false;
      try {
        if (options.transport === 'poll') {
          await pollOnce(signal);
          await wait(pollIntervalMs, signal);
          continue;
        }

        connected = await tryWs(signal);
        if (signal.aborted) return;
        if (!connected) {
          connected = await trySse(signal);
        }
        if (signal.aborted) return;

        if (!connected) {
          // Poll only as reconnect fallback while WS/SSE are down.
          handlers.onDisconnect?.('fallback_poll');
          await pollOnce(signal);
          await wait(pollIntervalMs, signal);
          handlers.onReconnect?.();
          continue;
        }

        handlers.onReconnect?.();
        // After a clean SSE read finishes, briefly pause then retry prefer-WS.
        await wait(250, signal);
      } catch {
        if (signal.aborted) return;
        await wait(pollIntervalMs, signal);
      }
    }
  };

  void loop();

  return {
    cleanup: () => abort.abort(),
    getTransport: () => current,
  };
};

/** Apply message-related events onto a transcript controller. */
export const applyChatEventToTranscript = (
  event: OpenChamberEvent,
  sessionId: string,
  actions: {
    upsertLiveTail: (messageId: string, text: string, role?: 'assistant' | 'user') => void;
    finalizeLiveTail: (messageId: string, text: string) => void;
    upsertLivePart?: (messageId: string, part: Record<string, unknown>, role?: 'assistant' | 'user') => void;
    setBusy: (busy: boolean) => void;
  },
): boolean => {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  const eventSession =
    (typeof props.sessionID === 'string' && props.sessionID) ||
    (typeof props.sessionId === 'string' && props.sessionId) ||
    null;
  if (eventSession && eventSession !== sessionId) return false;

  if (event.type === 'message.part.delta' || event.type === 'message.part.updated') {
    const messageID = typeof props.messageID === 'string' ? props.messageID : null;
    const delta = typeof props.delta === 'string' ? props.delta : null;
    const part = props.part && typeof props.part === 'object' ? (props.part as Record<string, unknown>) : null;
    const partType = typeof part?.type === 'string' ? part.type : null;

    // Tool / reasoning parts never paint into the primary text bubble.
    if (messageID && part && (partType === 'tool' || partType === 'reasoning')) {
      if (partType === 'reasoning' && typeof delta === 'string' && delta.length > 0) {
        const prior = typeof part.text === 'string' ? part.text : '';
        actions.upsertLivePart?.(messageID, { ...part, text: prior + delta }, 'assistant');
      } else {
        actions.upsertLivePart?.(messageID, part, 'assistant');
      }
      return true;
    }

    const text =
      delta ??
      (typeof part?.text === 'string' ? part.text : null) ??
      (typeof props.text === 'string' ? props.text : null);
    if (messageID && text != null && (partType == null || partType === 'text')) {
      actions.upsertLiveTail(messageID, text, 'assistant');
      return true;
    }
  }

  if (event.type === 'message.updated' || event.type === 'message.completed') {
    const info = props.info && typeof props.info === 'object' ? (props.info as Record<string, unknown>) : null;
    const messageID =
      (typeof props.messageID === 'string' && props.messageID) ||
      (typeof info?.id === 'string' && info.id) ||
      null;
    const text = typeof props.text === 'string' ? props.text : '';
    if (messageID) {
      actions.finalizeLiveTail(messageID, text);
      return true;
    }
  }

  if (event.type === 'session.status' || event.type === 'session.idle') {
    const status = props.status;
    const busy =
      status === 'busy' ||
      status === 'running' ||
      (status && typeof status === 'object' && (status as { type?: string }).type === 'busy');
    actions.setBusy(Boolean(busy) && event.type !== 'session.idle');
    return true;
  }

  return false;
};
