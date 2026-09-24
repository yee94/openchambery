export const COMPOSER_QUOTE_LIMIT = 10;
export const EMPTY_COMPOSER_QUOTES: readonly string[] = Object.freeze([]);

export const composerQuoteKey = (sessionId: string | null | undefined, draftId: string | null | undefined): string | null => {
  if (sessionId) return `session:${sessionId}`;
  if (draftId) return `draft:${draftId}`;
  return null;
};

export const appendComposerQuote = (quotes: readonly string[], text: string): readonly string[] => {
  const quote = text.trim();
  if (!quote || quotes.includes(quote)) return quotes;
  return [...quotes, quote].slice(-COMPOSER_QUOTE_LIMIT);
};

export const CONVERSATION_QUOTE_HEADER = 'Quoted from the conversation:';

const quoteBlock = (quote: string): string => quote.split('\n').map((line) => `> ${line}`).join('\n');

const isQuoteBlock = (block: string): boolean => {
  const lines = block.split('\n');
  return lines.length > 0 && lines.every((line) => line.startsWith('>'));
};

const unwrapQuoteBlock = (block: string): string => block.split('\n').map((line) => line.replace(/^>\s?/, '')).join('\n');

/**
 * Split a sent user message back into staged conversation quotes and the
 * authored body. Returns null when the text is not our quote prefix, so
 * ordinary messages that happen to contain `>` stay untouched.
 */
export const splitQuotedConversationMessage = (text: string): { quotes: readonly string[]; body: string } | null => {
  if (!text.startsWith(CONVERSATION_QUOTE_HEADER)) return null;
  const rest = text.slice(CONVERSATION_QUOTE_HEADER.length).replace(/^\n+/, '');
  if (!rest) return { quotes: [], body: '' };
  const blocks = rest.split(/\n\n/);
  const quotes: string[] = [];
  let index = 0;
  while (index < blocks.length && isQuoteBlock(blocks[index] ?? '')) {
    quotes.push(unwrapQuoteBlock(blocks[index] ?? ''));
    index += 1;
  }
  if (quotes.length === 0) return null;
  return { quotes, body: blocks.slice(index).join('\n\n') };
};

/** Slash commands keep their text; quotes stay staged for the next real message. */
export const messageWithComposerQuotes = (quotes: readonly string[], message: string): string => {
  if (quotes.length === 0 || message.trimStart().startsWith('/')) return message;
  const quoted = [CONVERSATION_QUOTE_HEADER, ...quotes.map(quoteBlock)].join('\n\n');
  return message ? `${quoted}\n\n${message}` : quoted;
};

const prefixComposerQuoteText = (message: string, quotes: readonly string[]): { text: string; offset: number } => {
  const text = messageWithComposerQuotes(quotes, message);
  return { text, offset: text === message ? 0 : text.length - message.length };
};

const shiftReferenceRanges = <T extends { start: number; end: number }>(references: readonly T[], offset: number): T[] => (
  offset === 0 ? references.slice() : references.map((reference) => ({ ...reference, start: reference.start + offset, end: reference.end + offset }))
);

export const documentWithComposerQuotes = <T extends { text: string; references: ReadonlyArray<{ start: number; end: number }> }>(document: T, quotes: readonly string[]): T => {
  const prefixed = prefixComposerQuoteText(document.text, quotes);
  if (prefixed.offset === 0) return document;
  return { ...document, text: prefixed.text, references: shiftReferenceRanges(document.references, prefixed.offset) };
};
