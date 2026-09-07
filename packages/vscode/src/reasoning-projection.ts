/**
 * OpenChamber outbound reasoning projection (VS Code Extension Host).
 *
 * `includeReasoning=false` (strict string only) strips reasoning from
 * Host→webview HTTP/SSE payloads. Missing/other values keep current behavior.
 * OpenChamber-only — never forward the param to OpenCode.
 *
 * Parity with packages/web/server/lib/event-stream/reasoning-projection.js
 * (surface used by sseProxy + bridge-proxy / turn-page).
 */

const REASONING_DELTA_FIELDS = new Set([
  'reasoning',
  'reasoning_content',
  'reasoning_details',
]);

/** Match UI opencode-event-normalizer: strip terminal `.N` version suffix for dispatch. */
const VERSIONED_TYPE = /^(.*)\.(\d+)$/;

const PART_TYPE_CACHE_LIMIT = 8192;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const baseEventType = (type: string): string => {
  const match = VERSIONED_TYPE.exec(type);
  return match?.[1] ?? type;
};

/** Strict: only string `'false'` disables. */
export function shouldIncludeReasoning(value: unknown): boolean {
  if (Array.isArray(value) && value.length > 0) return value[0] !== 'false';
  return value !== 'false';
}

export function readIncludeReasoningQuery(query: unknown): boolean {
  if (!query || typeof query !== 'object') return true;
  return shouldIncludeReasoning((query as Record<string, unknown>).includeReasoning);
}

export function readIncludeReasoningFromUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.includes('includeReasoning=')) return true;
  try {
    return shouldIncludeReasoning(new URL(rawUrl, 'http://openchamber.local').searchParams.get('includeReasoning'));
  } catch {
    return true;
  }
}

/** Strip OpenChamber-only `includeReasoning` before OpenCode upstream. */
export function stripIncludeReasoningParam(requestUrl: string): string {
  if (typeof requestUrl !== 'string' || !requestUrl.includes('includeReasoning=')) return requestUrl;
  try {
    const url = new URL(requestUrl, 'http://openchamber.local');
    if (!url.searchParams.has('includeReasoning')) return requestUrl;
    url.searchParams.delete('includeReasoning');
    const search = url.searchParams.toString();
    if (requestUrl.startsWith('http://') || requestUrl.startsWith('https://')) {
      return `${url.origin}${url.pathname}${search ? `?${search}` : ''}${url.hash || ''}`;
    }
    return `${url.pathname}${search ? `?${search}` : ''}${url.hash || ''}`;
  } catch {
    return requestUrl;
  }
}

function projectParts(parts: unknown): unknown {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  let changed = false;
  const next: unknown[] = [];
  for (const part of parts) {
    if (isPlainObject(part) && part.type === 'reasoning') {
      changed = true;
      continue;
    }
    next.push(part);
  }
  return changed ? next : parts;
}

/** One message record: `{ info, parts }`. */
function projectRecord(record: unknown): unknown {
  if (!isPlainObject(record) || !Array.isArray(record.parts)) return record;
  const parts = projectParts(record.parts);
  return parts === record.parts ? record : { ...record, parts };
}

/**
 * Real payload shapes only: array / `{ records }` / `{ record }` / `{ parts }`.
 */
export function projectMessagesPayloadWithoutReasoning(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    let changed = false;
    const next = payload.map((entry) => {
      const projected = projectRecord(entry);
      if (projected !== entry) changed = true;
      return projected;
    });
    return changed ? next : payload;
  }

  if (!isPlainObject(payload)) return payload;

  let next: Record<string, unknown> = payload;
  let changed = false;

  if (Array.isArray(payload.records)) {
    const records = projectMessagesPayloadWithoutReasoning(payload.records);
    if (records !== payload.records) {
      next = { ...next, records };
      changed = true;
    }
  }

  if (isPlainObject(payload.record)) {
    const record = projectRecord(payload.record);
    if (record !== payload.record) {
      next = { ...next, record };
      changed = true;
    }
  }

  if (Array.isArray(payload.parts)) {
    const projected = projectRecord(next);
    if (projected !== next) {
      next = projected as Record<string, unknown>;
      changed = true;
    }
  }

  return changed ? next : payload;
}

export function projectMessagesPayloadForReasoning(
  payload: unknown,
  includeReasoning: boolean,
): unknown {
  if (includeReasoning) return payload;
  return projectMessagesPayloadWithoutReasoning(payload);
}

const eventBodyKeys = ['properties', 'data'] as const;

function eventBodyOf(payload: unknown): Record<string, unknown> | null {
  if (!isPlainObject(payload)) return null;
  for (const key of eventBodyKeys) {
    const body = payload[key];
    if (isPlainObject(body)) return body;
  }
  return null;
}

export type ReasoningOutboundFilter = {
  projectEvent: (payload: unknown) => unknown | null;
  knownPartCount: () => number;
  dispose: () => void;
};

/** Stateful per-connection outbound filter. Classification map is bounded. */
export function createReasoningOutboundFilter(): ReasoningOutboundFilter {
  const partTypes = new Map<string, string>();

  const partKey = (messageID: string, partID: string) => `${messageID}\0${partID}`;

  const rememberPartType = (messageID: string, partID: string, type: string) => {
    if (!messageID || !partID || !type) return;
    const key = partKey(messageID, partID);
    if (partTypes.size >= PART_TYPE_CACHE_LIMIT && !partTypes.has(key)) {
      const oldest = partTypes.keys().next().value;
      if (oldest !== undefined) partTypes.delete(oldest);
    }
    partTypes.set(key, type);
  };

  const forgetPart = (messageID: string, partID: string) => {
    if (messageID && partID) partTypes.delete(partKey(messageID, partID));
  };

  const forgetMessage = (messageID: string) => {
    if (!messageID) return;
    const prefix = `${messageID}\0`;
    for (const key of Array.from(partTypes.keys())) {
      if (key.startsWith(prefix)) partTypes.delete(key);
    }
  };

  const projectEvent = (payload: unknown): unknown | null => {
    if (!isPlainObject(payload)) return payload;

    const rawType = typeof payload.type === 'string' ? payload.type : '';
    const type = baseEventType(rawType);

    if (type.startsWith('session.next.reasoning.')) return null;

    if (type === 'message.part.updated') {
      const body = eventBodyOf(payload);
      const part = body && isPlainObject(body.part) ? body.part : null;
      if (part) {
        const bodyMessageID = body && typeof body.messageID === 'string' ? body.messageID : '';
        const messageID =
          (typeof part.messageID === 'string' && part.messageID)
          || bodyMessageID
          || '';
        const partID = typeof part.id === 'string' ? part.id : '';
        if (typeof part.type === 'string') rememberPartType(messageID, partID, part.type);
        if (part.type === 'reasoning') return null;
      }
      return payload;
    }

    if (type === 'message.part.delta') {
      const body = eventBodyOf(payload);
      if (!body) return null;

      const messageID = typeof body.messageID === 'string' ? body.messageID : '';
      const partID = typeof body.partID === 'string' ? body.partID : '';
      const field = typeof body.field === 'string' ? body.field : '';

      if (REASONING_DELTA_FIELDS.has(field)) return null;

      const learned = messageID && partID ? partTypes.get(partKey(messageID, partID)) : undefined;
      if (learned === 'reasoning' || learned === undefined) return null;
      return payload;
    }

    if (type === 'message.part.removed') {
      const body = eventBodyOf(payload);
      if (body) {
        forgetPart(
          typeof body.messageID === 'string' ? body.messageID : '',
          typeof body.partID === 'string' ? body.partID : '',
        );
      }
      return payload;
    }

    if (type === 'message.removed') {
      const body = eventBodyOf(payload);
      if (body) {
        const messageID =
          (typeof body.messageID === 'string' && body.messageID)
          || (isPlainObject(body.info) && typeof body.info.id === 'string' && body.info.id)
          || '';
        forgetMessage(messageID);
      }
      return payload;
    }

    if (type === 'message.updated' || type === 'message.created') {
      let next: Record<string, unknown> = payload;
      let changed = false;
      for (const key of eventBodyKeys) {
        const body = next[key];
        if (!isPlainObject(body) || !Array.isArray(body.parts)) continue;
        const parts = projectParts(body.parts);
        if (parts === body.parts) continue;
        next = { ...next, [key]: { ...body, parts } };
        changed = true;
      }
      return changed ? next : payload;
    }

    return payload;
  };

  return {
    projectEvent,
    knownPartCount: () => partTypes.size,
    dispose: () => {
      partTypes.clear();
    },
  };
}

function projectSseDataJson(
  dataJson: unknown,
  filter: Pick<ReasoningOutboundFilter, 'projectEvent'>,
): { action: 'drop' } | { action: 'keep'; value: unknown; changed: boolean } {
  if (!isPlainObject(dataJson)) {
    return { action: 'keep', value: dataJson, changed: false };
  }

  if (isPlainObject(dataJson.payload) && typeof dataJson.payload.type === 'string') {
    const projected = filter.projectEvent(dataJson.payload);
    if (projected == null) return { action: 'drop' };
    if (projected === dataJson.payload) return { action: 'keep', value: dataJson, changed: false };
    return { action: 'keep', value: { ...dataJson, payload: projected }, changed: true };
  }

  const projected = filter.projectEvent(dataJson);
  if (projected == null) return { action: 'drop' };
  if (projected === dataJson) return { action: 'keep', value: dataJson, changed: false };
  return { action: 'keep', value: projected, changed: true };
}

/** Filter one SSE block. null = drop. */
export function filterSseBlock(
  block: string,
  filter: Pick<ReasoningOutboundFilter, 'projectEvent'>,
): string | null {
  if (typeof block !== 'string' || block.trim().length === 0) return null;
  if (!block.includes('data:')) return `${block}\n\n`;

  const lines = block.split('\n');
  const dataLines: string[] = [];
  const otherLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
    else otherLines.push(line);
  }
  if (dataLines.length === 0) return `${block}\n\n`;

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) return `${block}\n\n`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return `${block}\n\n`;
  }

  const result = projectSseDataJson(parsed, filter);
  if (result.action === 'drop') return null;
  if (!result.changed) return `${block}\n\n`;
  return [...otherLines, `data: ${JSON.stringify(result.value)}`, '', ''].join('\n');
}

/**
 * Incremental SSE block splitter. Holds trailing CR so `\r`+`\n` across chunks
 * never invents a false blank line that would split one event in two.
 */
export function createSseBlockSplitter() {
  const decoder = new TextDecoder();
  let buffer = '';
  let carryCr = '';

  const appendNormalized = (text: string) => {
    if (!text && !carryCr) return;
    let input = carryCr + (text || '');
    carryCr = '';
    if (input.endsWith('\r')) {
      carryCr = '\r';
      input = input.slice(0, -1);
    }
    buffer += input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  };

  const drainBlocks = (): string[] => {
    const blocks: string[] = [];
    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.trim().length > 0) blocks.push(block);
    }
    return blocks;
  };

  return {
    push(chunk: Uint8Array | string): string[] {
      const text = typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
      if (!text) return [];
      appendNormalized(text);
      return drainBlocks();
    },
    finish(): string[] {
      const tail = decoder.decode();
      if (tail) appendNormalized(tail);
      if (carryCr) {
        buffer += '\n';
        carryCr = '';
      }
      const remaining = buffer;
      buffer = '';
      return remaining.trim().length > 0 ? [remaining] : [];
    },
  };
}
