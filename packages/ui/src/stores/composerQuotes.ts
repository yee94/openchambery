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

const quoteBlock = (quote: string): string => quote.split('\n').map((line) => `> ${line}`).join('\n');

/** Slash commands keep their text; quotes stay staged for the next real message. */
export const messageWithComposerQuotes = (quotes: readonly string[], message: string): string => {
  if (quotes.length === 0 || message.trimStart().startsWith('/')) return message;
  const quoted = ['Quoted from the conversation:', ...quotes.map(quoteBlock)].join('\n\n');
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
