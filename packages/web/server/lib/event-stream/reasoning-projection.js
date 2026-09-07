/**
 * OpenChamber outbound reasoning projection.
 *
 * `includeReasoning=false` (strict string only) strips reasoning from Host→client
 * HTTP/SSE/WS payloads. Missing/other values keep current behavior. OpenChamber
 * projection only — never forward the param to OpenCode. Hub/upstream stay full.
 *
 * Shared by HTTP snapshots and stateful stream filters:
 * drop type=reasoning parts, their deltas, session.next.reasoning.* events.
 * Keep tokens.reasoning totals, tools, text, status, permissions/errors.
 * Never mutate hub/replay objects.
 */

const REASONING_DELTA_FIELDS = new Set([
  'reasoning',
  'reasoning_content',
  'reasoning_details',
]);

/** Match UI opencode-event-normalizer: strip terminal `.N` version suffix for dispatch. */
const VERSIONED_TYPE = /^(.*)\.(\d+)$/;

const PART_TYPE_CACHE_LIMIT = 8192;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** @param {string} type */
const baseEventType = (type) => {
  const match = VERSIONED_TYPE.exec(type);
  return match?.[1] ?? type;
};

/**
 * Strict: only string `'false'` disables. Missing / other keep include.
 * @param {unknown} value
 * @returns {boolean}
 */
export function shouldIncludeReasoning(value) {
  if (Array.isArray(value) && value.length > 0) return value[0] !== 'false';
  return value !== 'false';
}

/** @param {unknown} query */
export function readIncludeReasoningQuery(query) {
  if (!query || typeof query !== 'object') return true;
  return shouldIncludeReasoning(/** @type {Record<string, unknown>} */ (query).includeReasoning);
}

/** @param {string} rawUrl */
export function readIncludeReasoningFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.includes('includeReasoning=')) return true;
  try {
    return shouldIncludeReasoning(new URL(rawUrl, 'http://openchamber.local').searchParams.get('includeReasoning'));
  } catch {
    return true;
  }
}

/**
 * Strip OpenChamber-only `includeReasoning` before OpenCode upstream.
 * @param {string} requestUrl
 */
export function stripIncludeReasoningParam(requestUrl) {
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

/** @param {unknown} parts */
function projectParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  let changed = false;
  const next = [];
  for (const part of parts) {
    if (isPlainObject(part) && part.type === 'reasoning') {
      changed = true;
      continue;
    }
    next.push(part);
  }
  return changed ? next : parts;
}

/**
 * One message record: `{ info, parts }` (turn-page / exact / cache / session.messages).
 * @param {unknown} record
 */
function projectRecord(record) {
  if (!isPlainObject(record) || !Array.isArray(record.parts)) return record;
  const parts = projectParts(record.parts);
  return parts === record.parts ? record : { ...record, parts };
}

/**
 * Real Host payload shapes only:
 * - bare array of records
 * - `{ records: [...] }` (turn-page / reconcile / cache session)
 * - `{ record }` (cache message)
 * - `{ info, parts }` (exact message)
 *
 * @param {unknown} payload
 */
export function projectMessagesPayloadWithoutReasoning(payload) {
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

  let next = payload;
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

  // Exact message / single record body: top-level parts.
  if (Array.isArray(payload.parts)) {
    const projected = projectRecord(next);
    if (projected !== next) {
      next = projected;
      changed = true;
    }
  }

  return changed ? next : payload;
}

/**
 * @param {unknown} payload
 * @param {boolean} includeReasoning
 */
export function projectMessagesPayloadForReasoning(payload, includeReasoning) {
  if (includeReasoning) return payload;
  return projectMessagesPayloadWithoutReasoning(payload);
}

const eventBodyKeys = /** @type {const} */ (['properties', 'data']);

/** @param {unknown} payload */
function eventBodyOf(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of eventBodyKeys) {
    const body = payload[key];
    if (isPlainObject(body)) return body;
  }
  return null;
}

/**
 * Stateful per-connection outbound filter. Classification map is bounded.
 * @returns {{ projectEvent: (payload: unknown) => unknown | null, knownPartCount: () => number, dispose: () => void }}
 */
export function createReasoningOutboundFilter() {
  /** @type {Map<string, string>} */
  const partTypes = new Map();

  const partKey = (messageID, partID) => `${messageID}\0${partID}`;

  const rememberPartType = (messageID, partID, type) => {
    if (typeof messageID !== 'string' || !messageID) return;
    if (typeof partID !== 'string' || !partID) return;
    if (typeof type !== 'string' || !type) return;
    const key = partKey(messageID, partID);
    if (partTypes.size >= PART_TYPE_CACHE_LIMIT && !partTypes.has(key)) {
      const oldest = partTypes.keys().next().value;
      if (oldest !== undefined) partTypes.delete(oldest);
    }
    partTypes.set(key, type);
  };

  const forgetPart = (messageID, partID) => {
    if (typeof messageID === 'string' && typeof partID === 'string') {
      partTypes.delete(partKey(messageID, partID));
    }
  };

  const forgetMessage = (messageID) => {
    if (typeof messageID !== 'string' || !messageID) return;
    const prefix = `${messageID}\0`;
    for (const key of Array.from(partTypes.keys())) {
      if (key.startsWith(prefix)) partTypes.delete(key);
    }
  };

  /**
   * @param {unknown} payload
   * @returns {unknown | null} null = drop; otherwise original or shallow-cloned payload (type string preserved)
   */
  const projectEvent = (payload) => {
    if (!isPlainObject(payload)) return payload;

    const rawType = typeof payload.type === 'string' ? payload.type : '';
    const type = baseEventType(rawType);

    // session.next.reasoning.* (incl. versioned …reasoning.delta.1)
    if (type.startsWith('session.next.reasoning.')) return null;

    if (type === 'message.part.updated') {
      const body = eventBodyOf(payload);
      const part = body && isPlainObject(body.part) ? body.part : null;
      if (part) {
        const messageID =
          (typeof part.messageID === 'string' && part.messageID)
          || (typeof body.messageID === 'string' && body.messageID)
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

    // message.updated / message.created may embed parts on properties or data.
    if (type === 'message.updated' || type === 'message.created') {
      let next = payload;
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

/**
 * Project SSE data JSON; preserve GlobalEvent `{ directory, payload }` wrap.
 * @param {unknown} dataJson
 * @param {{ projectEvent: (payload: unknown) => unknown | null }} filter
 */
function projectSseDataJson(dataJson, filter) {
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

/**
 * Filter one SSE block (no trailing separator). null = drop.
 * @param {string} block
 * @param {{ projectEvent: (payload: unknown) => unknown | null }} filter
 * @returns {string | null}
 */
export function filterSseBlock(block, filter) {
  if (typeof block !== 'string' || block.trim().length === 0) return null;
  if (!block.includes('data:')) return `${block}\n\n`;

  const lines = block.split('\n');
  const dataLines = [];
  const otherLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
    else otherLines.push(line);
  }
  if (dataLines.length === 0) return `${block}\n\n`;

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) return `${block}\n\n`;

  let parsed;
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
 * Incremental SSE block splitter. Holds a trailing CR so `\r` + `\n` across
 * chunks never invents a false blank line (which would split one event in two).
 */
export function createSseBlockSplitter() {
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {string} trailing CR held until the next chunk clarifies `\r\n` vs lone `\r` */
  let carryCr = '';

  const appendNormalized = (text) => {
    if (!text && !carryCr) return;
    let input = carryCr + (text || '');
    carryCr = '';
    if (input.endsWith('\r')) {
      carryCr = '\r';
      input = input.slice(0, -1);
    }
    // Complete CRLF pairs first, then any remaining lone CR → LF.
    buffer += input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  };

  const drainBlocks = () => {
    const blocks = [];
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
    /**
     * @param {Uint8Array | string} chunk
     * @returns {string[]}
     */
    push(chunk) {
      const text = typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
      if (!text) return [];
      appendNormalized(text);
      return drainBlocks();
    },
    /** @returns {string[]} */
    finish() {
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
