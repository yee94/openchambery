/**
 * Live tail for Lynx chat timeline against Cap mobile event stream.
 *
 * Contract:
 * - One LegendList owns history + live updates (`appendLiveEntries` / in-place
 *   part patches). **No** separate streaming overlay / TanStack split list.
 * - `maintainScrollAtEnd` stays driven by existing listSemantics flags.
 * - Abort/working and queue flush come from `session.status` / idle events.
 *
 * Transport: Cap uses WS (`/api/global/event/ws`) with SSE fallback
 * (`/api/global/event`). Lynx opens SSE first (Bearer on fetch). Host may inject
 * a WS opener later; without a streaming body the subscribe fails honestly.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { parseLynxMessageParts, textFromLynxParts, type LynxMessagePart } from './messageParts';
import {
  LYNX_GLOBAL_EVENT_SSE_PATH,
  createLynxSseParseState,
  normalizeLynxOpenCodeEvent,
  projectLynxLiveEvent,
  pushLynxSseText,
  type LynxLiveTimelinePatch,
  type LynxNormalizedEvent,
} from './liveEvents';
import {
  appendLiveEntries,
  setSessionWorking,
  type LynxTimelineEntry,
  type LynxTimelineState,
} from './timelineModel';

export type LynxLiveTailConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'failed';

export type LynxLiveTailEffect =
  | { type: 'timeline'; state: LynxTimelineState }
  | { type: 'connection'; state: LynxLiveTailConnectionState; error?: string }
  | { type: 'flush-queue' }
  | { type: 'reload-pending-cards' };

export type LynxEventStreamOpenResult = {
  ok: boolean;
  status: number;
  /** Incremental UTF-8 text chunks (SSE). Absent → transport cannot live-tail. */
  chunks?: AsyncIterable<string>;
  error?: string;
};

export type LynxEventStreamOpen = (input: {
  path: string;
  signal: AbortSignal;
  headers?: Record<string, string>;
  lastEventId?: string;
}) => Promise<LynxEventStreamOpenResult>;

const partText = (part: Record<string, unknown>): string => {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
};

const upsertParts = (
  existing: LynxMessagePart[] | undefined,
  part: Record<string, unknown>,
): LynxMessagePart[] => {
  const parsed = parseLynxMessageParts([part]);
  const nextPart = parsed[0];
  if (!nextPart) return existing ?? [];
  const list = [...(existing ?? [])];
  const id = typeof part.id === 'string' ? part.id : null;
  if (id) {
    const index = list.findIndex((row) => {
      const raw = row as LynxMessagePart & { id?: string };
      return raw.id === id;
    });
    if (index >= 0) {
      list[index] = nextPart;
      return list;
    }
  }
  list.push(nextPart);
  return list;
};

const applyDeltaToParts = (
  existing: LynxMessagePart[] | undefined,
  partID: string,
  field: string,
  delta: string,
): LynxMessagePart[] => {
  const list = [...(existing ?? [])];
  const index = list.findIndex((row) => (row as { id?: string }).id === partID);
  if (index < 0) {
    if (field === 'text' || field === 'content') {
      list.push({ type: 'text', id: partID, text: delta } as LynxMessagePart);
    }
    return list;
  }
  const current = list[index] as LynxMessagePart & Record<string, unknown>;
  if (field === 'text' || field === 'content') {
    const prev = typeof current.text === 'string'
      ? current.text
      : typeof current.content === 'string'
        ? String(current.content)
        : '';
    list[index] = { ...current, type: 'text', text: prev + delta } as LynxMessagePart;
  }
  return list;
};

/**
 * Apply one live patch into the single timeline list (no overlay).
 */
export function applyLynxLivePatch(
  state: LynxTimelineState,
  patch: LynxLiveTimelinePatch,
): LynxTimelineState {
  switch (patch.kind) {
    case 'session-working':
      return setSessionWorking(state, patch.working);
    case 'activity':
      return setSessionWorking(state, !patch.terminal);
    case 'remove-message':
      return {
        ...state,
        entries: state.entries.filter((entry) => entry.messageId !== patch.messageId),
      };
    case 'upsert-message': {
      const entry: LynxTimelineEntry = {
        key: patch.messageId,
        messageId: patch.messageId,
        role: patch.role,
        text: patch.text ?? '',
        createdAt: patch.createdAt,
        parts: patch.parts ? parseLynxMessageParts(patch.parts) : undefined,
      };
      return appendLiveEntries(state, [entry]);
    }
    case 'part-updated': {
      const existing = state.entries.find((entry) => entry.messageId === patch.messageId);
      const parts = upsertParts(existing?.parts, patch.part);
      const text = textFromLynxParts(parts) || partText(patch.part) || existing?.text || '';
      const entry: LynxTimelineEntry = {
        key: patch.messageId,
        messageId: patch.messageId,
        role: existing?.role ?? 'assistant',
        text,
        createdAt: existing?.createdAt,
        parts,
      };
      return appendLiveEntries(state, [entry]);
    }
    case 'part-delta': {
      const existing = state.entries.find((entry) => entry.messageId === patch.messageId);
      const parts = applyDeltaToParts(existing?.parts, patch.partID, patch.field, patch.delta);
      const entry: LynxTimelineEntry = {
        key: patch.messageId,
        messageId: patch.messageId,
        role: existing?.role ?? 'assistant',
        text: textFromLynxParts(parts) || (existing?.text ?? '') + patch.delta,
        createdAt: existing?.createdAt,
        parts,
      };
      return appendLiveEntries(state, [entry]);
    }
  }
}

export function applyNormalizedEventToTimeline(
  state: LynxTimelineState,
  event: LynxNormalizedEvent,
): { state: LynxTimelineState; patch: LynxLiveTimelinePatch | null } {
  const patch = projectLynxLiveEvent(event, state.sessionId);
  if (!patch) return { state, patch: null };
  return { state: applyLynxLivePatch(state, patch), patch };
}

const decoder = new TextDecoder();

async function* readUtf8Chunks(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        yield decoder.decode(value, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Open Cap global-event SSE via runtimeFetch when the response exposes a body
 * stream. Buffered-only transports return `{ ok:false }` — never pretend live.
 */
export function createLynxSseOpenFromRuntimeFetch(
  runtimeFetch: LynxRuntimeFetch,
): LynxEventStreamOpen {
  return async ({ path, signal, headers, lastEventId }) => {
    const requestHeaders: Record<string, string> = {
      Accept: 'text/event-stream',
      ...headers,
    };
    if (lastEventId) requestHeaders['Last-Event-ID'] = lastEventId;

    const response = await runtimeFetch(path, {
      method: 'GET',
      headers: requestHeaders,
      signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `event stream failed (${response.status})`,
      };
    }

    if (!response.body) {
      return {
        ok: false,
        status: response.status,
        error: 'event stream has no body — host/http must expose ReadableStream for SSE',
      };
    }

    return {
      ok: true,
      status: response.status,
      chunks: readUtf8Chunks(response.body, signal),
    };
  };
}

export type SubscribeLynxLiveTailInput = {
  sessionId: string;
  directory?: string | null;
  openStream: LynxEventStreamOpen;
  /** Mutable timeline getter/setter owned by ChatScreen. */
  getTimeline: () => LynxTimelineState;
  setTimeline: (state: LynxTimelineState) => void;
  onEffect?: (effect: LynxLiveTailEffect) => void;
  signal: AbortSignal;
  /** Cap default path. */
  path?: string;
  reconnectDelayMs?: number;
};

/**
 * Subscribe to Cap global event SSE and fold matching frames into the timeline.
 * Reconnects until aborted. Queue flush fires once when the session becomes idle.
 */
export async function subscribeLynxLiveTail(
  input: SubscribeLynxLiveTailInput,
): Promise<void> {
  const path = input.path ?? LYNX_GLOBAL_EVENT_SSE_PATH;
  const reconnectDelayMs = input.reconnectDelayMs ?? 1_000;
  let lastEventId: string | undefined;
  let first = true;

  const emitConnection = (state: LynxLiveTailConnectionState, error?: string) => {
    input.onEffect?.({ type: 'connection', state, error });
  };

  while (!input.signal.aborted) {
    emitConnection(first ? 'connecting' : 'reconnecting');
    first = false;

    let opened: LynxEventStreamOpenResult;
    try {
      opened = await input.openStream({
        path,
        signal: input.signal,
        lastEventId,
      });
    } catch (error) {
      if (input.signal.aborted) return;
      emitConnection('failed', error instanceof Error ? error.message : 'stream open failed');
      await sleep(reconnectDelayMs, input.signal);
      continue;
    }

    if (!opened.ok || !opened.chunks) {
      emitConnection('failed', opened.error ?? 'stream unavailable');
      // Permanent for this subscribe attempt shape — wait then retry in case
      // the host later upgrades the transport (relay body appears).
      await sleep(reconnectDelayMs, input.signal);
      continue;
    }

    emitConnection('open');
    const parseState = createLynxSseParseState();
    if (lastEventId) parseState.lastEventId = lastEventId;

    try {
      for await (const chunk of opened.chunks) {
        if (input.signal.aborted) return;
        const commits = pushLynxSseText(parseState, chunk);
        for (const commit of commits) {
          if (commit.id) lastEventId = commit.id;
          if (commit.raw == null) continue;
          const normalized = normalizeLynxOpenCodeEvent(commit.raw);
          if (normalized.action !== 'emit') continue;
          const { state, patch } = applyNormalizedEventToTimeline(
            input.getTimeline(),
            normalized.event,
          );
          if (patch) {
            input.setTimeline(state);
            input.onEffect?.({ type: 'timeline', state });
            if (patch.kind === 'session-working' && patch.becameIdle) {
              input.onEffect?.({ type: 'flush-queue' });
              input.onEffect?.({ type: 'reload-pending-cards' });
            }
            if (patch.kind === 'part-updated' || patch.kind === 'upsert-message') {
              // Permission/question cards may arrive beside parts.
              input.onEffect?.({ type: 'reload-pending-cards' });
            }
          }
        }
      }
      if (input.signal.aborted) return;
      emitConnection('closed');
    } catch (error) {
      if (input.signal.aborted) return;
      emitConnection('failed', error instanceof Error ? error.message : 'stream read failed');
    }

    await sleep(reconnectDelayMs, input.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
