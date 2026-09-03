export const CONTACT_CARD_TYPES = Object.freeze(['session', 'assistant', 'schedule']);
const CARD_TYPES = new Set(CONTACT_CARD_TYPES);
// Assign / create_assistant / schedule_task auto-insert these cards.
// project | worktree | watch MUST reuse this slot. Do not invent a second card system.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const parseSessionCard = (value) => {
  const sessionID = string(value.sessionID);
  const directory = string(value.directory);
  if (!sessionID || !directory) return null;
  return {
    type: 'card',
    cardType: 'session',
    sessionID,
    directory,
    title: string(value.title) || null,
    status: string(value.status) || null,
    branch: string(value.branch) || null,
  };
};

const parseAssistantCard = (value) => {
  const assistantID = string(value.assistantID);
  const name = string(value.name);
  const providerID = string(value.providerID);
  const modelID = string(value.modelID);
  if (!assistantID || !name || !providerID || !modelID) return null;
  const mode = string(value.mode) === 'stateless' ? 'stateless' : 'continuous';
  return {
    type: 'card',
    cardType: 'assistant',
    assistantID,
    name,
    providerID,
    modelID,
    mode,
  };
};

const parseScheduleCard = (value) => {
  const taskID = string(value.taskID);
  const projectID = string(value.projectID);
  const name = string(value.name);
  if (!taskID || !projectID || !name) return null;
  return {
    type: 'card',
    cardType: 'schedule',
    taskID,
    projectID,
    name,
    kind: string(value.kind) || null,
    time: string(value.time) || null,
    timezone: string(value.timezone) || null,
    prompt: string(value.prompt) || null,
  };
};

/**
 * First-class in-transcript card. Extensible via `cardType`.
 * Session cards navigate with the existing session route, not markdown links.
 */
export function parseContactCard(value) {
  if (!isRecord(value)) return null;
  const cardType = string(value.cardType);
  if (!CARD_TYPES.has(cardType)) return null;
  if (cardType === 'session') return parseSessionCard(value);
  if (cardType === 'assistant') return parseAssistantCard(value);
  if (cardType === 'schedule') return parseScheduleCard(value);
  return null;
}

export function parseContactFilePart(value) {
  if (!isRecord(value) || value.type !== 'file') return null;
  const mime = string(value.mime);
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : '';
  if (!mime || !url) return null;
  const filename = string(value.filename);
  return filename ? { type: 'file', mime, url, filename } : { type: 'file', mime, url };
}

export function parseContactPart(value) {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text };
  }
  if (value.type === 'file') {
    return parseContactFilePart(value);
  }
  if (value.type === 'card') {
    return parseContactCard(value);
  }
  return null;
}

export function serializeContactPart(part, index) {
  return {
    id: part.id || `oc_contact_part:${index + 1}`,
    ...part,
  };
}

export function contactCardIdentity(card) {
  if (!card || card.type !== 'card') return '';
  if (card.cardType === 'session') return `session:${card.sessionID}:${card.directory}`;
  if (card.cardType === 'assistant') return `assistant:${card.assistantID}`;
  if (card.cardType === 'schedule') return `schedule:${card.projectID}:${card.taskID}`;
  return card.cardType;
}

const createCardPart = (cardType, input, requiredMessage) => {
  const card = parseContactCard({ type: 'card', cardType, ...input });
  if (!card) {
    const error = new Error(requiredMessage);
    error.code = 'validation_error';
    throw error;
  }
  return card;
};

/** Build a session card. Throws so insert paths fail closed. */
export function createSessionCardPart(input) {
  if (!string(input?.sessionID)) {
    const error = new Error('sessionID is required');
    error.code = 'validation_error';
    throw error;
  }
  return createCardPart('session', input, 'Invalid session card');
}

export function createAssistantCardPart(input) {
  if (!string(input?.assistantID)) {
    const error = new Error('assistantID is required');
    error.code = 'validation_error';
    throw error;
  }
  return createCardPart('assistant', input, 'Invalid assistant card');
}

export function createScheduleCardPart(input) {
  if (!string(input?.taskID) || !string(input?.projectID)) {
    const error = new Error('taskID and projectID are required');
    error.code = 'validation_error';
    throw error;
  }
  return createCardPart('schedule', input, 'Invalid schedule card');
}
