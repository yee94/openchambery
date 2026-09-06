/**
 * Minimal Cap composer-autocomplete trigger + accept helpers for Expo.
 * Priority matches Cap ChatInput: leading `/` commands, mid-line `/` skills,
 * `#` snippets, then `@` mentions. Search/filter stays in app code.
 */

export type ComposerAutocompleteKind = 'slash-command' | 'slash-skill' | 'mention' | 'snippet';

export type ComposerAutocompleteTrigger = {
  kind: ComposerAutocompleteKind;
  query: string;
  tokenStart: number;
  tokenEnd: number;
};

export type ComposerAutocompleteRow = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  /** Text inserted when the row is accepted (includes trigger prefix when needed). */
  insertText: string;
};

const triggerPrefix = (kind: ComposerAutocompleteKind): string => {
  if (kind === 'mention') return '@';
  if (kind === 'snippet') return '#';
  return '/';
};

/** Cap getFileMentionAutocompleteQuery subset (manual typing only). */
export const getMentionQueryAtCursor = (text: string, cursor: number): string | null => {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const lastAt = before.lastIndexOf('@');
  if (lastAt === -1) return null;
  const charBefore = lastAt > 0 ? before[lastAt - 1] : null;
  const after = before.slice(lastAt + 1);
  const isWordBoundary = !charBefore || /\s/.test(charBefore);
  if (!isWordBoundary || after.includes(' ') || after.includes('\n')) return null;
  return after;
};

/**
 * Resolve live autocomplete trigger at caret.
 * Shell mode is omitted on Expo (no `!` shell composer).
 */
export const resolveComposerAutocompleteTrigger = (
  text: string,
  cursor: number,
): ComposerAutocompleteTrigger | null => {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));

  if (text.startsWith('/')) {
    const firstSpace = text.indexOf(' ');
    const firstNewline = text.indexOf('\n');
    const commandEnd = Math.min(
      firstSpace === -1 ? text.length : firstSpace,
      firstNewline === -1 ? text.length : firstNewline,
    );
    if (safeCursor <= commandEnd && firstSpace === -1) {
      return {
        kind: 'slash-command',
        query: text.slice(1, commandEnd),
        tokenStart: 0,
        tokenEnd: commandEnd,
      };
    }
  }

  const before = text.slice(0, safeCursor);
  const lastSlash = before.lastIndexOf('/');
  if (lastSlash !== -1) {
    const charBefore = lastSlash > 0 ? before[lastSlash - 1] : null;
    const afterSlash = before.slice(lastSlash + 1);
    const hasSeparator = afterSlash.includes(' ') || afterSlash.includes('\n');
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (isWordBoundary && !hasSeparator) {
      return {
        kind: 'slash-skill',
        query: afterSlash,
        tokenStart: lastSlash,
        tokenEnd: safeCursor,
      };
    }
  }

  const lastHash = before.lastIndexOf('#');
  if (lastHash !== -1) {
    const charBefore = lastHash > 0 ? before[lastHash - 1] : null;
    const afterHash = before.slice(lastHash + 1);
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (isWordBoundary && !afterHash.includes(' ') && !afterHash.includes('\n')) {
      return {
        kind: 'snippet',
        query: afterHash,
        tokenStart: lastHash,
        tokenEnd: safeCursor,
      };
    }
  }

  const mentionQuery = getMentionQueryAtCursor(text, safeCursor);
  if (mentionQuery === null) return null;
  const lastAt = before.lastIndexOf('@');
  return {
    kind: 'mention',
    query: mentionQuery,
    tokenStart: lastAt,
    tokenEnd: safeCursor,
  };
};

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
  const live = resolveComposerAutocompleteTrigger(text, caret);
  if (!live) return null;
  return { start: live.tokenStart, end: live.tokenEnd };
};

/** Accept a suggestion: replace open token and leave a trailing space. */
export const acceptComposerAutocompleteRow = (
  text: string,
  caret: number,
  openTrigger: ComposerAutocompleteTrigger | null,
  insertText: string,
): { text: string; caret: number } | null => {
  const range = resolveComposerAutocompleteReplaceRange(text, caret, openTrigger);
  if (!range) return null;
  const insertion = insertText.endsWith(' ') ? insertText : `${insertText} `;
  const next = `${text.slice(0, range.start)}${insertion}${text.slice(range.end)}`;
  return { text: next, caret: range.start + insertion.length };
};

const scoreMatch = (haystack: string, query: string): number | null => {
  const h = haystack.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (h === q) return 0;
  if (h.startsWith(q)) return 1;
  const idx = h.indexOf(q);
  if (idx >= 0) return 10 + idx;
  return null;
};

export const filterRowsByQuery = <T extends { title: string; subtitle?: string }>(
  rows: readonly T[],
  query: string,
  limit = 24,
): T[] => {
  const q = query.trim();
  if (!q) return rows.slice(0, limit);
  const scored = rows.flatMap((row) => {
    const score = (() => {
      const a = scoreMatch(row.title, q);
      const b = row.subtitle ? scoreMatch(row.subtitle, q) : null;
      if (a === null && b === null) return null;
      return Math.min(a ?? Number.POSITIVE_INFINITY, b ?? Number.POSITIVE_INFINITY);
    })();
    if (score === null) return [];
    return [{ row, score }];
  });
  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    return left.row.title.localeCompare(right.row.title);
  });
  return scored.slice(0, limit).map((entry) => entry.row);
};
