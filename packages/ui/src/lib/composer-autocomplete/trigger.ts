import { getFileMentionAutocompleteQuery } from '@/components/chat/fileMentionAutocompleteState';
import { stripLeadingSlashCommandSlot } from '@/components/chat/typedSlashChipPromotion';

import type {
  ComposerAutocompleteInputMode,
  ComposerAutocompleteMentionSource,
  ComposerAutocompleteTrigger,
} from './types';

export type ResolveComposerAutocompleteTriggerInput = {
  text: string;
  cursor: number;
  inputMode?: ComposerAutocompleteInputMode;
  mentionInputSource?: ComposerAutocompleteMentionSource;
  insertedText?: string;
};

/**
 * Resolve the live composer autocomplete trigger at `cursor`.
 * Priority matches ChatInput: shell off, leading `/` commands, mid-line
 * `/` skills, `#` snippets, then `@` mentions.
 */
export const resolveComposerAutocompleteTrigger = (
  input: ResolveComposerAutocompleteTriggerInput,
): ComposerAutocompleteTrigger | null => {
  if (input.inputMode === 'shell') {
    return null;
  }

  const text = input.text;
  const cursor = Math.max(0, Math.min(input.cursor, text.length));

  if (text.startsWith('/')) {
    const firstSpace = text.indexOf(' ');
    const firstNewline = text.indexOf('\n');
    const commandEnd = Math.min(
      firstSpace === -1 ? text.length : firstSpace,
      firstNewline === -1 ? text.length : firstNewline,
    );

    if (cursor <= commandEnd && firstSpace === -1) {
      return {
        kind: 'slash-command',
        query: stripLeadingSlashCommandSlot(text.substring(1, commandEnd)),
        tokenStart: 0,
        tokenEnd: commandEnd,
      };
    }
  }

  const textBeforeCursor = text.substring(0, cursor);
  const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');
  if (lastSlashSymbol !== -1) {
    const charBefore = lastSlashSymbol > 0 ? textBeforeCursor[lastSlashSymbol - 1] : null;
    const textAfterSlash = stripLeadingSlashCommandSlot(textBeforeCursor.substring(lastSlashSymbol + 1));
    const hasSeparator = textAfterSlash.includes(' ') || textAfterSlash.includes('\n');
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (isWordBoundary && !hasSeparator) {
      return {
        kind: 'slash-skill',
        query: textAfterSlash,
        tokenStart: lastSlashSymbol,
        tokenEnd: cursor,
      };
    }
  }

  const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
  if (lastHashSymbol !== -1) {
    const charBefore = lastHashSymbol > 0 ? textBeforeCursor[lastHashSymbol - 1] : null;
    const textAfterHash = textBeforeCursor.substring(lastHashSymbol + 1);
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (isWordBoundary && !textAfterHash.includes(' ') && !textAfterHash.includes('\n')) {
      return {
        kind: 'snippet',
        query: textAfterHash,
        tokenStart: lastHashSymbol,
        tokenEnd: cursor,
      };
    }
  }

  const mentionQuery = getFileMentionAutocompleteQuery({
    value: text,
    cursorPosition: cursor,
    inputSource: input.mentionInputSource ?? 'manual',
    insertedText: input.insertedText,
  });
  if (mentionQuery === null) {
    return null;
  }

  const lastAt = textBeforeCursor.lastIndexOf('@');
  return {
    kind: 'mention',
    query: mentionQuery,
    tokenStart: lastAt,
    tokenEnd: cursor,
  };
};

const triggerPrefix = (kind: ComposerAutocompleteTrigger['kind']): string => {
  if (kind === 'mention') return '@';
  if (kind === 'snippet') return '#';
  return '/';
};

/**
 * Range the web composer replaces when a suggestion is accepted.
 * Prefers the open trigger (the token that produced the list) so a stale
 * native caret cannot insert at 0 and leave `@query` in the field.
 */
export const resolveComposerAutocompleteReplaceRange = (
  text: string,
  caret: number,
  openTrigger: ComposerAutocompleteTrigger | null,
): { start: number; end: number } | null => {
  if (
    openTrigger
    && openTrigger.tokenStart >= 0
    && openTrigger.tokenEnd >= openTrigger.tokenStart
    && openTrigger.tokenEnd <= text.length
    && text.startsWith(triggerPrefix(openTrigger.kind), openTrigger.tokenStart)
  ) {
    return { start: openTrigger.tokenStart, end: openTrigger.tokenEnd };
  }
  const live = resolveComposerAutocompleteTrigger({ text, cursor: caret });
  if (!live) return null;
  return { start: live.tokenStart, end: live.tokenEnd };
};
