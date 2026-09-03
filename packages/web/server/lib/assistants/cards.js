export const CONTACT_CARD_TYPES = Object.freeze(['session']);
const CARD_TYPES = new Set(CONTACT_CARD_TYPES);
// Assign auto-inserts this same session card. project | worktree | watch
// MUST reuse this slot. Do not invent a second card system.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/**
 * First-class in-transcript card. Extensible via `cardType`.
 * Session cards navigate with the existing session route, not markdown links.
 */
export function parseContactCard(value) {
  if (!isRecord(value)) return null;
  const cardType = string(value.cardType);
  if (!CARD_TYPES.has(cardType)) return null;
  if (cardType === 'session') {
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
  }
  return null;
}

export function parseContactPart(value) {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text };
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

/** Build a session card. Throws so insert paths fail closed. */
export function createSessionCardPart(input) {
  const sessionID = string(input?.sessionID);
  if (!sessionID) {
    const error = new Error('sessionID is required');
    error.code = 'validation_error';
    throw error;
  }
  const card = parseContactCard({ type: 'card', cardType: 'session', ...input, sessionID });
  if (!card) {
    const error = new Error('Invalid session card');
    error.code = 'validation_error';
    throw error;
  }
  return card;
}
