const SENTENCE = /(?<=[.!?])\s+(?=[A-Z“"‘])/u;

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
