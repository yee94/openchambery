import { describe, expect, test } from 'vitest';
import { appendComposerQuote, composerQuoteKey, documentWithComposerQuotes, messageWithComposerQuotes, splitQuotedConversationMessage } from './composerQuotes';

describe('composer quotes', () => {
  test('keys prefer the session and fall back to the new-session draft', () => {
    expect(composerQuoteKey('ses_1', 'draft_1')).toBe('session:ses_1');
    expect(composerQuoteKey(null, 'draft_1')).toBe('draft:draft_1');
    expect(composerQuoteKey(null, null)).toBeNull();
  });

  test('appends trimmed unique quotes and keeps the newest ten', () => {
    const first = appendComposerQuote([], '  hello  ');
    expect(appendComposerQuote(first, 'hello')).toBe(first);
    expect(appendComposerQuote(first, '   ')).toBe(first);
    const filled = Array.from({ length: 10 }, (_, index) => `q${index}`);
    expect(appendComposerQuote(filled, 'q10')).toEqual([...filled.slice(1), 'q10']);
  });

  test('prefixes a real message and leaves slash commands untouched', () => {
    expect(messageWithComposerQuotes(['line one\nline two'], 'explain')).toBe('Quoted from the conversation:\n\n> line one\n> line two\n\nexplain');
    expect(messageWithComposerQuotes(['keep'], '/compact')).toBe('/compact');
    expect(messageWithComposerQuotes([], 'explain')).toBe('explain');
    expect(splitQuotedConversationMessage(messageWithComposerQuotes(['line one\nline two', 'alpha'], 'explain'))).toEqual({
      quotes: ['line one\nline two', 'alpha'],
      body: 'explain',
    });
    expect(splitQuotedConversationMessage('> not our prefix')).toBeNull();
    expect(splitQuotedConversationMessage('Quoted from the conversation:\n\nplain paragraph')).toBeNull();
  });

  test('shifts reference ranges by the prefix and leaves commands unchanged', () => {
    const document = { text: 'see @file', references: [{ id: 'r1', start: 4, end: 9 }] };
    const quoted = documentWithComposerQuotes(document, ['alpha']);
    expect(quoted.text.startsWith('Quoted from the conversation:\n\n> alpha\n\nsee @file')).toBe(true);
    expect(quoted.references[0]).toEqual({ id: 'r1', start: quoted.text.indexOf('@file'), end: quoted.text.indexOf('@file') + 5 });
    expect(documentWithComposerQuotes(document, [])).toBe(document);
    expect(documentWithComposerQuotes({ text: '/compact', references: [] }, ['alpha'])).toEqual({ text: '/compact', references: [] });
  });
});
