/**
 * Cap OpenChamber contact-turn envelopes for the Lynx contact transcript.
 *
 * Wire (Cap `openchamberEvents.ts` + `broadcastContactTurnEvent`):
 * `data: {"type":"openchamber:contact-turn-start|contact-bubble-delta|contact-turn-end","properties":{...}}`
 * on the existing `GET /api/openchamber/events` SSE — not a new route.
 * Chat session tails stay on `/api/global/event`. Both use the same
 * `openStream` / runtimeFetch opener.
 *
 * Malformed envelopes return null. They never become a fake turn.
 * `cancelled` is a real server end status (Cap UI parser drops it). Lynx
 * accepts it so a remote cancel clears the working preview without marking
 * the turn complete.
 */
import {
  createLynxSseParseState,
  normalizeLynxOpenCodeEvent,
  pushLynxSseText,
} from '../chat/liveEvents';
import type { LynxEventStreamOpen, LynxLiveTailConnectionState } from '../chat/liveTail';

export const LYNX_OPENCHAMBER_EVENTS_SSE_PATH = '/api/openchamber/events' as const;

export type LynxContactTurnStartEvent = {
  type: 'contact-turn-start';
  assistantID: string;
  turnID: string;
  messageID: string;
  occurredAt: number;
};

export type LynxContactBubbleDeltaEvent = {
  type: 'contact-bubble-delta';
  assistantID: string;
  turnID: string;
  bubbleIndex: number;
  delta: string;
  done: boolean;
  occurredAt: number;
};

export type LynxContactTurnEndEvent = {
  type: 'contact-turn-end';
  assistantID: string;
  turnID: string;
  status: 'complete' | 'error' | 'cancelled';
  error?: string;
  occurredAt: number;
};

export type LynxContactTurnEvent =
  | LynxContactTurnStartEvent
  | LynxContactBubbleDeltaEvent
  | LynxContactTurnEndEvent;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/**
 * Parse one Cap `{ type, properties }` envelope.
 * Returns null when the shape is not a contact event or is malformed.
 */
export function parseLynxContactEventEnvelope(
  envelope: { type?: unknown; properties?: unknown } | null | undefined,
): LynxContactTurnEvent | null {
  const type = typeof envelope?.type === 'string' ? envelope.type : '';
  const parsed = asRecord(envelope?.properties);
  if (!type || !parsed) return null;

  if (type === 'openchamber:contact-turn-start') {
    const assistantID = typeof parsed.assistantID === 'string' ? parsed.assistantID.trim() : '';
    const turnID = typeof parsed.turnID === 'string' ? parsed.turnID.trim() : '';
    const messageID = typeof parsed.messageID === 'string' ? parsed.messageID.trim() : '';
    const occurredAt = parsed.occurredAt;
    if (!assistantID || !turnID || !messageID || turnID !== messageID) return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    return { type: 'contact-turn-start', assistantID, turnID, messageID, occurredAt };
  }

  if (type === 'openchamber:contact-bubble-delta') {
    const assistantID = typeof parsed.assistantID === 'string' ? parsed.assistantID.trim() : '';
    const turnID = typeof parsed.turnID === 'string' ? parsed.turnID.trim() : '';
    const bubbleIndex = parsed.bubbleIndex;
    const delta = parsed.delta;
    const done = parsed.done;
    const occurredAt = parsed.occurredAt;
    if (!assistantID || !turnID) return null;
    if (typeof bubbleIndex !== 'number' || !Number.isSafeInteger(bubbleIndex) || bubbleIndex < 0) return null;
    if (typeof delta !== 'string' || typeof done !== 'boolean') return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    return { type: 'contact-bubble-delta', assistantID, turnID, bubbleIndex, delta, done, occurredAt };
  }

  if (type === 'openchamber:contact-turn-end') {
    const assistantID = typeof parsed.assistantID === 'string' ? parsed.assistantID.trim() : '';
    const turnID = typeof parsed.turnID === 'string' ? parsed.turnID.trim() : '';
    const status = parsed.status;
    const occurredAt = parsed.occurredAt;
    if (!assistantID || !turnID) return null;
    if (status !== 'complete' && status !== 'error' && status !== 'cancelled') return null;
    if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
    const error = typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : undefined;
    return {
      type: 'contact-turn-end',
      assistantID,
      turnID,
      status,
      ...(error ? { error } : {}),
      occurredAt,
    };
  }

  return null;
}

/** Parse a frame already normalized by `normalizeLynxOpenCodeEvent`. */
function parseLynxContactNormalizedEvent(
  event: { type: string; properties?: Record<string, unknown> },
): LynxContactTurnEvent | null {
  return parseLynxContactEventEnvelope({
    type: event.type,
    properties: event.properties ?? {},
  });
}

function lynxContactEventMatchesAssistant(
  event: LynxContactTurnEvent,
  assistantID: string,
): boolean {
  return event.assistantID === assistantID;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted || ms <= 0) return Promise.resolve();
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
};

export type SubscribeLynxContactEventsInput = {
  assistantID: string;
  openStream: LynxEventStreamOpen;
  signal: AbortSignal;
  onEvent: (event: LynxContactTurnEvent) => void;
  onConnection?: (state: LynxLiveTailConnectionState, error?: string) => void;
  /** Cap contact bus. Defaults to `/api/openchamber/events`. */
  path?: string;
  reconnectDelayMs?: number;
};

/**
 * Subscribe to Cap contact-* events for one assistant.
 * Reuses the chat SSE opener (`runtimeFetch` + `ReadableStream`). A failed
 * open is reported and retried; it does not synthesize turns.
 */
export async function subscribeLynxContactEvents(
  input: SubscribeLynxContactEventsInput,
): Promise<void> {
  const path = input.path ?? LYNX_OPENCHAMBER_EVENTS_SSE_PATH;
  const reconnectDelayMs = input.reconnectDelayMs ?? 1_000;
  const assistantID = input.assistantID.trim();
  let lastEventId: string | undefined;
  let first = true;

  const emitConnection = (state: LynxLiveTailConnectionState, error?: string) => {
    input.onConnection?.(state, error);
  };

  while (!input.signal.aborted) {
    emitConnection(first ? 'connecting' : 'reconnecting');
    first = false;

    let opened: Awaited<ReturnType<LynxEventStreamOpen>>;
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
          const parsed = parseLynxContactNormalizedEvent(normalized.event);
          if (!parsed || !lynxContactEventMatchesAssistant(parsed, assistantID)) continue;
          input.onEvent(parsed);
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
