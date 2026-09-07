const SENTENCE = /(?<=[.!?])\s+(?=[A-Z“"‘])/u;
const CONTACT_PLANNING = /\b(let me think|i should|i need to|i'll call|i will call|the user (said|wants|asked)|actually,?|hmm\.?|assign_session|list_projects|list_sessions|create_assistant|schedule_task|tool call|projectPath)\b/i;

/**
 * A short spoken contact line (not chain-of-thought). Shown before a tool and kept.
 */
export function isContactSpokenPreamble(text, { maxChars = 80 } = {}) {
  if (typeof text !== 'string') return false;
  const next = text.replace(/\r\n/g, '\n').trim();
  if (!next || next.length > maxChars) return false;
  if (/\n{2,}/u.test(next)) return false;
  if (/```/.test(next)) return false;
  if (CONTACT_PLANNING.test(next)) return false;
  return true;
}

/**
 * Split model output into short contact bubbles.
 * Blank-line paragraphs first; long paragraphs split on sentence boundaries.
 */
export function splitContactBubbles(text, { maxChars = 280 } = {}) {
  const raw = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!raw) return [];
  const paragraphs = raw.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const bubbles = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      bubbles.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(SENTENCE).map((part) => part.trim()).filter(Boolean);
    let current = '';
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (next.length > maxChars && current) {
        bubbles.push(current);
        current = sentence;
      } else {
        current = next;
      }
    }
    if (current) bubbles.push(current);
  }
  return bubbles.length > 0 ? bubbles : [raw];
}
