import type { Session } from '@opencode-ai/sdk/v2';
import { scoreTextAgainstQuery } from '@/lib/search/fuzzySearch';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';

export type FileMentionAutocompleteInputSource = 'manual' | 'paste';

export type FileMentionPathHit = ProjectFileSearchHit & {
  isDirectory?: boolean;
};

/**
 * Merge file + directory search hits into one flat list ranked by path/name
 * similarity. Lower score is better (same tiers as scoreTextAgainstQuery).
 * Does not group by kind — folder vs file only differs by isDirectory.
 */
export const mergeAndRankFileMentionPathHits = ({
  files,
  directories,
  query,
  excludePaths,
  limit = 20,
}: {
  files: readonly ProjectFileSearchHit[];
  directories: readonly ProjectFileSearchHit[];
  query: string;
  excludePaths?: ReadonlySet<string>;
  limit?: number;
}): FileMentionPathHit[] => {
  const byPath = new Map<string, FileMentionPathHit>();

  for (const hit of directories) {
    if (!hit.path || excludePaths?.has(hit.path)) continue;
    byPath.set(hit.path, { ...hit, isDirectory: true });
  }

  for (const hit of files) {
    if (!hit.path || excludePaths?.has(hit.path) || byPath.has(hit.path)) continue;
    byPath.set(hit.path, { ...hit, isDirectory: hit.isDirectory === true });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const items = Array.from(byPath.values());
  if (!normalizedQuery) {
    return items.slice(0, limit);
  }

  const scored = items.map((item) => {
    const path = (item.relativePath || item.name || '').toLowerCase();
    const name = (item.name || '').toLowerCase();
    const pathScore = scoreTextAgainstQuery(path, normalizedQuery);
    const nameScore = scoreTextAgainstQuery(name, normalizedQuery);
    let score: number;
    if (pathScore === null && nameScore === null) {
      // Server may return fuzzy-only hits; keep them after substring tiers.
      score = 10 + path.length / 1e4;
    } else {
      score = Math.min(
        pathScore ?? Number.POSITIVE_INFINITY,
        nameScore ?? Number.POSITIVE_INFINITY,
      );
    }
    return { item, score, sortKey: path };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.sortKey.length !== b.sortKey.length) return a.sortKey.length - b.sortKey.length;
    return a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: 'accent' });
  });

  return scored.slice(0, limit).map(({ item }) => item);
};

const SESSION_MENTION_PATTERN = /(^|[\s([{])(@session:([A-Za-z0-9_-]+))(?=$|[\s)\]},.!?;:])/g;

type SessionMentionRange = {
    start: number;
    end: number;
    id: string;
};

export const getSessionMentionToken = (sessionId: string): string => `session:${sessionId}`;

export const findSessionMentionRanges = (text: string): SessionMentionRange[] => {
    const ranges: SessionMentionRange[] = [];
    SESSION_MENTION_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = SESSION_MENTION_PATTERN.exec(text)) !== null) {
        const start = match.index + match[1].length;
        ranges.push({ start, end: start + match[2].length, id: match[3] });
    }
    return ranges;
};

export const collectSessionMentionIds = (text: string): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const { id } of findSessionMentionRanges(text)) {
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }

    return ids;
};

export const replaceSessionMentionTokens = (text: string, labels: ReadonlyMap<string, string>): string => {
    let result = text;
    for (const range of findSessionMentionRanges(text).reverse()) {
        const label = labels.get(range.id) ?? range.id;
        result = `${result.slice(0, range.start)}@${label}${result.slice(range.end)}`;
    }
    return result;
};

export const resolveSessionMentionDeletion = (
    text: string,
    key: 'Backspace' | 'Delete',
    selectionStart: number,
    selectionEnd: number,
): { text: string; caret: number } | null => {
    const range = findSessionMentionRanges(text).find((candidate) => {
        if (selectionStart !== selectionEnd) {
            return selectionStart < candidate.end && selectionEnd > candidate.start;
        }
        return key === 'Backspace'
            ? selectionStart > candidate.start && selectionStart <= candidate.end
            : selectionStart >= candidate.start && selectionStart < candidate.end;
    });
    if (!range) return null;

    const removeEnd = text[range.end] === ' ' ? range.end + 1 : range.end;
    return {
        text: `${text.slice(0, range.start)}${text.slice(removeEnd)}`,
        caret: range.start,
    };
};

export const getVisibleSessionMentionCandidates = ({
    sessions,
    currentSessionId,
    searchQuery,
}: {
    sessions: readonly Session[];
    currentSessionId: string | null;
    searchQuery: string;
}): Session[] => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return sessions
        .filter((session) => session.id !== currentSessionId)
        .filter((session) => !normalizedQuery || `${session.title ?? ''} ${session.id}`.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
        .slice(0, normalizedQuery ? 10 : 3);
};

export const getFileMentionAutocompleteQuery = ({
    value,
    cursorPosition,
    inputSource = 'manual',
    insertedText,
}: {
    value: string;
    cursorPosition: number;
    inputSource?: FileMentionAutocompleteInputSource;
    insertedText?: string;
}): string | null => {
    if (inputSource === 'paste' && insertedText?.includes('@')) {
        return null;
    }

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol === -1) {
        return null;
    }

    const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
    const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
    const isWordBoundary = !charBefore || /\s/.test(charBefore);
    if (!isWordBoundary || textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
        return null;
    }

    return textAfterAt;
};
