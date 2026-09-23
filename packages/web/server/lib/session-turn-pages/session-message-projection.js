/**
 * OpenCode v2 SessionMessageInfo → Host `{ info, parts }` projection.
 *
 * Shared by the web session-turn-pages routes and the VS Code turn-page
 * bridge so both runtimes expose the same external record contract.
 * Pure: no I/O, no logging.
 */

/**
 * Native SessionMessageInfo carrier fields that become `parts`.
 * Must not remain on `info` after normalize — otherwise
 * includeReasoning=false can strip parts while leaking content/text.
 */
const MESSAGE_PART_CARRIER_KEYS = new Set(['content', 'text', 'files', 'parts', 'agents', 'skills']);

/**
 * v2 session-lifecycle / control rows. OpenCode lists them alongside chat
 * turns; projecting `type`→`role` made cold reload paint empty Assistant
 * headers (FINAL-GATE hard reload). Align with UI session-projection-api.
 */
const CONTROL_MESSAGE_TYPES = new Set([
  'idle',
  'model-switched',
  'agent-selected',
  'agent-switched',
  'location-switched',
]);

const CHAT_MESSAGE_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'synthetic',
  'compaction',
]);

const asNonEmptyString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);

const stripMessagePartCarriers = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let changed = false;
  const next = {};
  for (const [key, field] of Object.entries(value)) {
    if (MESSAGE_PART_CARRIER_KEYS.has(key)) {
      changed = true;
      continue;
    }
    next[key] = field;
  }
  return changed ? next : value;
};

/**
 * True for v2 control rows that must never reach ChatMessage props.
 * Accepts raw SessionMessageInfo or already-projected `{ info, parts }`.
 */
const isControlSessionMessage = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  const info = entry.info && typeof entry.info === 'object' ? entry.info : entry;
  const type = asNonEmptyString(info.type);
  const role = asNonEmptyString(info.role) ?? asNonEmptyString(info.clientRole);
  if (type && CONTROL_MESSAGE_TYPES.has(type)) return true;
  if (role && CONTROL_MESSAGE_TYPES.has(role)) return true;
  return false;
};

/**
 * Project SessionMessageInfo body fields into host `parts`.
 *
 * v2 assistants put body in `content[]`. Users put body in top-level `text`.
 * Never expand both: the same string in `text` and `content[].text` produced
 * duplicate text parts (FINAL-GATE follow-up cold props).
 */
const projectV2Parts = (entry) => {
  if (Array.isArray(entry?.parts)) return entry.parts;
  const messageID = typeof entry?.id === 'string' ? entry.id : '';
  const sessionID = typeof entry?.sessionID === 'string' ? entry.sessionID : '';
  const parts = [];
  const content = Array.isArray(entry?.content) ? entry.content : null;
  const hasContent = Boolean(content && content.length > 0);

  if (hasContent) {
    let textOrdinal = 0;
    let reasoningOrdinal = 0;
    content.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'text') {
        const partID = asNonEmptyString(item.id) || `${messageID}:text:${textOrdinal}`;
        textOrdinal += 1;
        parts.push({
          id: partID,
          sessionID,
          messageID,
          type: 'text',
          text: typeof item.text === 'string' ? item.text : '',
        });
        return;
      }
      if (item.type === 'reasoning') {
        const partID = asNonEmptyString(item.id) || `${messageID}:reasoning:${reasoningOrdinal}`;
        reasoningOrdinal += 1;
        parts.push({
          id: partID,
          sessionID,
          messageID,
          type: 'reasoning',
          text: typeof item.text === 'string' ? item.text : '',
        });
        return;
      }
      if (item.type === 'tool') {
        const partID = asNonEmptyString(item.id) || `${messageID}:tool:${index}`;
        parts.push({
          id: partID,
          sessionID,
          messageID,
          type: 'tool',
          tool: item.name,
          callID: item.id,
          state: item.state ?? {},
        });
      }
    });
  } else if (typeof entry?.text === 'string' && entry.text) {
    // User / synthetic body when content[] is absent.
    parts.push({
      id: `${messageID}:text:0`,
      sessionID,
      messageID,
      type: 'text',
      text: entry.text,
    });
  }

  if (Array.isArray(entry?.files)) {
    entry.files.forEach((file, index) => {
      parts.push({
        id: `${messageID}:file:${index}`,
        sessionID,
        messageID,
        type: 'file',
        mime: file?.mime || 'application/octet-stream',
        url: file?.uri ?? file?.url,
        ...(file?.name ? { filename: file.name } : {}),
      });
    });
  }
  return parts;
};

/**
 * Build clean chat `info` from a native SessionMessageInfo row.
 * Does not spread wire carriers (`type`, `rawFinish`, `outcome`, `content`).
 */
const projectNativeSessionInfo = (entry, role) => {
  const info = {
    id: entry.id,
    ...(asNonEmptyString(entry.sessionID) ? { sessionID: entry.sessionID } : {}),
    role,
    time: entry.time && typeof entry.time === 'object' ? entry.time : { created: 0 },
  };

  const agent = asNonEmptyString(entry.agent) ?? asNonEmptyString(entry.mode);
  if (agent) info.agent = agent;
  if (asNonEmptyString(entry.mode) && entry.mode !== agent) info.mode = entry.mode;

  const model = entry.model && typeof entry.model === 'object' && !Array.isArray(entry.model)
    ? entry.model
    : null;
  const modelID = asNonEmptyString(model?.id)
    ?? asNonEmptyString(model?.modelID)
    ?? asNonEmptyString(entry.modelID);
  const providerID = asNonEmptyString(model?.providerID) ?? asNonEmptyString(entry.providerID);
  const variant = asNonEmptyString(model?.variant) ?? asNonEmptyString(entry.variant);
  if (modelID) info.modelID = modelID;
  if (providerID) info.providerID = providerID;
  if (variant) info.variant = variant;
  if (modelID || providerID || variant) {
    info.model = {
      ...(providerID ? { providerID } : {}),
      ...(modelID ? { modelID } : {}),
      ...(variant ? { variant } : {}),
    };
  }

  const finish = asNonEmptyString(entry.finish) ?? asNonEmptyString(entry.rawFinish);
  if (finish) info.finish = finish;

  if (entry.error && typeof entry.error === 'object' && !Array.isArray(entry.error)) {
    info.error = {
      type: asNonEmptyString(entry.error.type) ?? 'error',
      message: typeof entry.error.message === 'string' ? entry.error.message : '',
      ...(typeof entry.error.status === 'number' ? { status: entry.error.status } : {}),
    };
  }

  if (typeof entry.cost === 'number' && Number.isFinite(entry.cost)) info.cost = entry.cost;
  if (entry.tokens && typeof entry.tokens === 'object' && !Array.isArray(entry.tokens)) {
    info.tokens = entry.tokens;
  }
  if (asNonEmptyString(entry.parentID)) info.parentID = entry.parentID;
  if (entry.summary != null) info.summary = entry.summary;
  if (role === 'compaction') info.clientRole = 'compaction';
  if (role === 'system') info.clientRole = 'system';
  if (role === 'synthetic') {
    // Synthetic rows render as user-authored system injections in the UI.
    info.role = 'user';
    info.clientRole = 'system';
  }

  return info;
};

/**
 * Project SessionMessageInfo (or an already-projected {info, parts} row)
 * into the host HTTP DTO. External route contract stays {info, parts}.
 * Returns `null` for v2 control rows (idle / model-switched / …).
 */
export const projectSessionMessage = (entry) => {
  if (isControlSessionMessage(entry)) return null;

  if (entry && typeof entry === 'object' && entry.info && typeof entry.info === 'object') {
    if (isControlSessionMessage(entry.info)) return null;
    const stripped = stripMessagePartCarriers(entry.info);
    // Already-projected chat rows: keep shape, drop leftover wire carriers.
    const info = { ...stripped };
    delete info.type;
    delete info.rawFinish;
    delete info.outcome;
    // Normalize nested model.id → modelID when a prior path left wire shape.
    if (info.model && typeof info.model === 'object' && !Array.isArray(info.model)) {
      const modelID = asNonEmptyString(info.model.modelID)
        ?? asNonEmptyString(info.model.id)
        ?? asNonEmptyString(info.modelID);
      const providerID = asNonEmptyString(info.model.providerID) ?? asNonEmptyString(info.providerID);
      const variant = asNonEmptyString(info.model.variant) ?? asNonEmptyString(info.variant);
      if (modelID) info.modelID = modelID;
      if (providerID) info.providerID = providerID;
      info.model = {
        ...(providerID ? { providerID } : {}),
        ...(modelID ? { modelID } : {}),
        ...(variant ? { variant } : {}),
      };
    }
    const role = asNonEmptyString(info.role) ?? asNonEmptyString(info.clientRole);
    if (!role || CONTROL_MESSAGE_TYPES.has(role)) return null;
    return {
      info,
      parts: Array.isArray(entry.parts) ? entry.parts : [],
    };
  }

  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) {
    return entry == null ? null : entry;
  }

  const type = asNonEmptyString(entry.type);
  if (type && CONTROL_MESSAGE_TYPES.has(type)) return null;
  if (type && !CHAT_MESSAGE_TYPES.has(type)) return null;

  let role;
  if (type === 'user' || type === 'assistant' || type === 'system' || type === 'compaction' || type === 'synthetic') {
    role = type;
  } else if (asNonEmptyString(entry.role) === 'user' || asNonEmptyString(entry.role) === 'assistant') {
    role = entry.role;
  } else {
    return null;
  }

  return {
    info: projectNativeSessionInfo(entry, role),
    parts: projectV2Parts(entry),
  };
};

export const projectSessionMessageRecords = (records) =>
  (Array.isArray(records) ? records : [])
    .map(projectSessionMessage)
    .filter((record) => record != null && typeof record === 'object' && record.info);
