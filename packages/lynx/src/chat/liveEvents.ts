/**
 * Cap/OpenCode global event envelope parsing for Lynx chat live tail.
 *
 * Cap transport: `/api/global/event` (SSE) and `/api/global/event/ws` (WS),
 * with auto WS→SSE fallback (`packages/ui/src/sync/event-pipeline.ts`).
 * Lynx prefers SSE because Bearer auth rides the fetch header; WS needs
 * `oc_url_token` minting the host may not expose yet.
 *
 * Does **not** invent message.part deltas from session.next.* activity —
 * those are working/dirty hints only (Cap opencode-event-normalizer).
 */

export type LynxNormalizedEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
  locationDirectory?: string;
  admissionHint?: { sessionID: string; messageID?: string };
  domainActivityHint?: { sessionID: string; kind: 'activity' | 'terminal' };
};

export type LynxNormalizeEventResult =
  | { action: 'emit'; event: LynxNormalizedEvent }
  | { action: 'drop'; reason: 'sync-duplicate' | 'invalid' };

const VERSIONED_TYPE = /^(.*)\.(\d+)$/;

const ACTIVITY_PREFIXES = [
  'session.next.step.',
  'session.next.text.',
  'session.next.reasoning.',
  'session.next.tool.',
  'session.next.shell.',
  'session.next.compaction.',
] as const;

const TERMINAL_TYPES = new Set([
  'session.next.step.ended',
  'session.next.step.failed',
]);

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const stripVersionSuffix = (type: string): string => {
  const match = VERSIONED_TYPE.exec(type);
  return match?.[1] ?? type;
};

const readSessionID = (record: Record<string, unknown>): string | undefined => {
  const direct = record.sessionID;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const camel = record.sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  return undefined;
};

const isSyncDurableReplica = (record: Record<string, unknown>): boolean => {
  const durable = asRecord(record.durable);
  if (!durable) return false;
  const kind = durable.kind ?? durable.type ?? durable.source;
  if (typeof kind === 'string' && kind.toLowerCase() === 'sync') return true;
  if (durable.sync === true) return true;
  const aggregateID = durable.aggregateID;
  if (typeof aggregateID === 'string' && aggregateID.startsWith('sync:')) return true;
  return false;
};

const extractLocationDirectory = (record: Record<string, unknown>): string | undefined => {
  const location = asRecord(record.location);
  if (location) {
    const path = location.path ?? location.directory;
    if (typeof path === 'string' && path.length > 0) return path;
  }
  const directory = record.directory;
  if (typeof directory === 'string' && directory.length > 0) return directory;
  return undefined;
};

const unwrapGlobalEnvelope = (raw: unknown): unknown => {
  const record = asRecord(raw);
  if (!record) return raw;
  if (record.payload && typeof record.payload === 'object') {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === 'string') {
      return {
        ...payload,
        ...(typeof record.directory === 'string' && !extractLocationDirectory(payload)
          ? { directory: record.directory }
          : {}),
      };
    }
  }
  return raw;
};

const toLegacyProperties = (
  type: string,
  body: Record<string, unknown>,
): Record<string, unknown> => {
  if (type === 'session.status') {
    const sessionID = readSessionID(body);
    const status = body.status;
    if (sessionID && status && typeof status === 'object') {
      return { sessionID, status };
    }
  }
  return body;
};

const buildHints = (
  type: string,
  properties: Record<string, unknown>,
): Pick<LynxNormalizedEvent, 'admissionHint' | 'domainActivityHint'> => {
  const sessionID = readSessionID(properties);
  if (!sessionID) return {};

  if (type === 'session.next.prompt.admitted') {
    const messageID = typeof properties.messageID === 'string' ? properties.messageID : undefined;
    return {
      admissionHint: { sessionID, messageID },
      domainActivityHint: { sessionID, kind: 'activity' },
    };
  }
  if (TERMINAL_TYPES.has(type)) {
    return { domainActivityHint: { sessionID, kind: 'terminal' } };
  }
  if (ACTIVITY_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    return { domainActivityHint: { sessionID, kind: 'activity' } };
  }
  if (type.startsWith('session.next.')) {
    return { domainActivityHint: { sessionID, kind: 'activity' } };
  }
  return {};
};

/** Normalize one Cap/OpenCode transport frame (legacy properties or current data). */
export function normalizeLynxOpenCodeEvent(raw: unknown): LynxNormalizeEventResult {
  const unwrapped = unwrapGlobalEnvelope(raw);
  const record = asRecord(unwrapped);
  if (!record) return { action: 'drop', reason: 'invalid' };

  const rawType = record.type;
  if (typeof rawType !== 'string' || rawType.length === 0) {
    return { action: 'drop', reason: 'invalid' };
  }
  if (isSyncDurableReplica(record)) {
    return { action: 'drop', reason: 'sync-duplicate' };
  }

  const type = stripVersionSuffix(rawType);
  const dataBody = asRecord(record.data);
  const propertiesBody = asRecord(record.properties);
  const body = dataBody ?? propertiesBody;
  if (!body) {
    if (type.startsWith('openchamber:')) {
      return {
        action: 'emit',
        event: {
          id: typeof record.id === 'string' ? record.id : undefined,
          type,
          properties: propertiesBody ?? {},
          locationDirectory: extractLocationDirectory(record),
        },
      };
    }
    return { action: 'drop', reason: 'invalid' };
  }

  const properties = toLegacyProperties(type, body);
  const locationDirectory =
    extractLocationDirectory(record)
    ?? extractLocationDirectory(body)
    ?? (() => {
      const info = asRecord(properties.info);
      return typeof info?.directory === 'string' ? info.directory : undefined;
    })();

  return {
    action: 'emit',
    event: {
      id: typeof record.id === 'string' ? record.id : undefined,
      type,
      properties,
      locationDirectory,
      ...buildHints(type, properties),
    },
  };
}

/** Parse one SSE `data:` JSON payload (after line assembly). */
export function parseLynxSseDataLine(data: string): unknown | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * Incremental SSE text buffer → committed JSON payloads.
 * Spec: blank line ends an event; multiple `data:` lines join with `\n`.
 */
export type LynxSseParseState = {
  buffer: string;
  dataLines: string[];
  lastEventId: string | undefined;
};

export const createLynxSseParseState = (): LynxSseParseState => ({
  buffer: '',
  dataLines: [],
  lastEventId: undefined,
});

export type LynxSseCommit = {
  data: string;
  id?: string;
  raw: unknown | null;
};

export function pushLynxSseText(
  state: LynxSseParseState,
  chunk: string,
): LynxSseCommit[] {
  state.buffer += chunk;
  const commits: LynxSseCommit[] = [];
  let newline = state.buffer.indexOf('\n');
  while (newline >= 0) {
    let line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (line.length === 0) {
      if (state.dataLines.length > 0) {
        const data = state.dataLines.join('\n');
        const id = state.lastEventId;
        commits.push({ data, id, raw: parseLynxSseDataLine(data) });
        state.dataLines = [];
      }
    } else if (line.startsWith('data:')) {
      state.dataLines.push(line.slice(5).replace(/^ /, ''));
    } else if (line.startsWith('id:')) {
      const id = line.slice(3).replace(/^ /, '');
      if (id.length > 0) state.lastEventId = id;
    }
    // comments (`:`) and `event:` ignored — Cap heartbeats are comment frames.
    newline = state.buffer.indexOf('\n');
  }
  return commits;
}

export type LynxSessionWorkingStatus = 'busy' | 'retry' | 'idle';

export function readLynxSessionStatus(
  event: LynxNormalizedEvent,
): { sessionID: string; status: LynxSessionWorkingStatus } | null {
  if (event.type === 'session.status') {
    const sessionID = readSessionID(event.properties);
    const statusObj = asRecord(event.properties.status);
    const raw = statusObj?.type;
    if (!sessionID) return null;
    const status: LynxSessionWorkingStatus =
      raw === 'busy' ? 'busy' : raw === 'retry' ? 'retry' : 'idle';
    return { sessionID, status };
  }
  if (event.type === 'session.idle' || event.type === 'session.error') {
    const sessionID = readSessionID(event.properties);
    if (!sessionID) return null;
    return { sessionID, status: 'idle' };
  }
  return null;
}

export type LynxLiveTimelinePatch =
  | {
      kind: 'upsert-message';
      sessionID: string;
      messageId: string;
      role: 'user' | 'assistant' | 'system' | 'unknown';
      text?: string;
      parts?: unknown;
      createdAt?: number;
    }
  | {
      kind: 'part-updated';
      sessionID: string;
      messageId: string;
      part: Record<string, unknown>;
    }
  | {
      kind: 'part-delta';
      sessionID: string;
      messageId: string;
      partID: string;
      field: string;
      delta: string;
    }
  | {
      kind: 'remove-message';
      sessionID: string;
      messageId: string;
    }
  | {
      kind: 'session-working';
      sessionID: string;
      working: boolean;
      /** Idle after busy → composer may flush local queue. */
      becameIdle: boolean;
    }
  | {
      kind: 'activity';
      sessionID: string;
      terminal: boolean;
    };

const roleOf = (value: unknown): 'user' | 'assistant' | 'system' | 'unknown' => {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  return 'unknown';
};

/**
 * Project a normalized Cap event into a Lynx timeline/composer effect.
 * Events for other sessions return null (caller keeps one list, no overlay).
 */
export function projectLynxLiveEvent(
  event: LynxNormalizedEvent,
  sessionId: string,
): LynxLiveTimelinePatch | null {
  const status = readLynxSessionStatus(event);
  if (status) {
    if (status.sessionID !== sessionId) return null;
    const working = status.status === 'busy' || status.status === 'retry';
    return {
      kind: 'session-working',
      sessionID: status.sessionID,
      working,
      becameIdle: !working,
    };
  }

  if (event.domainActivityHint?.sessionID === sessionId) {
    return {
      kind: 'activity',
      sessionID: sessionId,
      terminal: event.domainActivityHint.kind === 'terminal',
    };
  }

  if (event.type === 'message.updated') {
    const info = asRecord(event.properties.info) ?? event.properties;
    const messageId = typeof info.id === 'string' ? info.id : '';
    const sessionID = typeof info.sessionID === 'string'
      ? info.sessionID
      : readSessionID(event.properties) ?? '';
    if (!messageId || sessionID !== sessionId) return null;
    const createdRaw = asRecord(info.time)?.created;
    return {
      kind: 'upsert-message',
      sessionID,
      messageId,
      role: roleOf(info.role),
      createdAt: typeof createdRaw === 'number' ? createdRaw : undefined,
    };
  }

  if (event.type === 'message.removed') {
    const sessionID = readSessionID(event.properties) ?? '';
    const messageId = typeof event.properties.messageID === 'string'
      ? event.properties.messageID
      : '';
    if (!messageId || sessionID !== sessionId) return null;
    return { kind: 'remove-message', sessionID, messageId };
  }

  if (event.type === 'message.part.updated') {
    const part = asRecord(event.properties.part);
    if (!part) return null;
    const messageId = typeof part.messageID === 'string' ? part.messageID : '';
    const sessionID =
      readSessionID(event.properties)
      ?? (typeof part.sessionID === 'string' ? part.sessionID : '');
    if (!messageId || sessionID !== sessionId) return null;
    return { kind: 'part-updated', sessionID, messageId, part };
  }

  if (event.type === 'message.part.delta') {
    const sessionID = readSessionID(event.properties) ?? '';
    const messageId = typeof event.properties.messageID === 'string'
      ? event.properties.messageID
      : '';
    const partID = typeof event.properties.partID === 'string' ? event.properties.partID : '';
    const field = typeof event.properties.field === 'string' ? event.properties.field : 'text';
    const delta = typeof event.properties.delta === 'string' ? event.properties.delta : '';
    if (!messageId || !partID || sessionID !== sessionId || !delta) return null;
    return { kind: 'part-delta', sessionID, messageId, partID, field, delta };
  }

  return null;
}

/** Cap global event SSE path (Bearer-friendly). WS sibling: `/api/global/event/ws`. */
export const LYNX_GLOBAL_EVENT_SSE_PATH = '/api/global/event' as const;
export const LYNX_GLOBAL_EVENT_WS_PATH = '/api/global/event/ws' as const;
