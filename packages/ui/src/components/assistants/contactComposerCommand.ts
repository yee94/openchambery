export type ContactComposerCommand =
  | { kind: 'send'; text: string }
  | { kind: 'session-card'; sessionID: string; title: string | null }
  | { kind: 'peer-dm'; toAssistantID: string; text: string };

const CARD_COMMAND = /^\/card\s+(\S+)(?:\s+(.+))?$/u;
const DM_COMMAND = /^\/dm\s+(\S+)\s+(.+)$/u;

/**
 * Tiny insert paths for this slice:
 * `/card <sessionID> [title]` emits a first-class session card.
 * `/dm <assistantID> <text>` delivers a read-only peer message.
 * Ordinary text is a contact send.
 */
export function parseContactComposerInput(raw: string): ContactComposerCommand | null {
  const text = raw.trim();
  if (!text) return null;
  const dm = text.match(DM_COMMAND);
  if (dm) {
    return {
      kind: 'peer-dm',
      toAssistantID: dm[1] ?? '',
      text: dm[2]?.trim() || '',
    };
  }
  const card = text.match(CARD_COMMAND);
  if (card) {
    return {
      kind: 'session-card',
      sessionID: card[1] ?? '',
      title: card[2]?.trim() || null,
    };
  }
  return { kind: 'send', text };
}
