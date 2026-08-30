import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import { rankFileMentionSearch, type FileMentionSearchHit } from '@/lib/search/fileMentionSearch';
import { scoreTextAgainstQuery } from '@/lib/search/fuzzySearch';

export {
  isTestFileMentionPath,
  parseFileMentionQuery,
  resolveFileMentionSearchQuery,
  type FileMentionQueryIntent,
} from '@/lib/search/fileMentionSearch';

export type FileMentionAutocompleteInputSource = 'manual' | 'paste';

export type FileMentionPathHit = ProjectFileSearchHit & {
  isDirectory?: boolean;
};

const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;
const MENTION_BOUNDARY_BEFORE = /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/;

export const looksLikeFilePath = (mention: string): boolean => (
  mention.includes('/') || mention.includes('\\') || mention.includes('.')
);

export const looksLikePastedFileReference = (mention: string): boolean => {
  if (!looksLikeFilePath(mention)) return false;
  const normalized = mention.replace(/\\/g, '/');
  if (normalized.endsWith('/')) return true;
  const lastSegment = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return FILE_EXTENSION_PATTERN.test(lastSegment);
};

/**
 * Merge file + directory search hits into one flat list ranked by the shared
 * file-mention search algorithm. Does not group by kind.
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

  return rankFileMentionSearch(Array.from(byPath.values()), query, { limit });
};

const RECENT_FILE_MENTION_LIMIT = 6;

/** Recent `@` paths use the same ranker as server file hits (`fileMentionSearch`). */
export const rankRecentFileMentionCandidates = <T extends FileMentionSearchHit>(
  files: readonly T[],
  searchQuery: string,
  options?: { limit?: number },
): T[] => rankFileMentionSearch(files, searchQuery, { limit: options?.limit ?? RECENT_FILE_MENTION_LIMIT });

const bestMentionScore = (left: number | null, right: number | null): number | null => {
  if (left === null && right === null) return null;
  return Math.min(left ?? Number.POSITIVE_INFINITY, right ?? Number.POSITIVE_INFINITY);
};

/** Agent `@` rows use the same substring tiers as path ranking (no Fuse). */
export const rankAgentMentionCandidates = <T extends { name: string; description?: string }>(
  agents: readonly T[],
  searchQuery: string,
): T[] => {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...agents].sort((left, right) => left.name.localeCompare(right.name));
  }
  const scored = agents.flatMap((agent) => {
    const score = bestMentionScore(
      scoreTextAgainstQuery(agent.name, normalizedQuery),
      scoreTextAgainstQuery(agent.description ?? '', normalizedQuery),
    );
    if (score === null) return [];
    return [{ agent, score }];
  });
  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    return left.agent.name.localeCompare(right.agent.name);
  });
  return scored.map((entry) => entry.agent);
};

export const isFileMentionTokenTerminated = (text: string, mentionEnd: number): boolean => {
  const next = text[mentionEnd];
  return next !== undefined && /\s/.test(next);
};

export const shouldHighlightFileMention = ({
  mention,
  confirmed,
  terminated,
}: {
  mention: string;
  confirmed: boolean;
  terminated: boolean;
}): boolean => {
  if (!mention || mention.startsWith('session:')) return false;
  if (confirmed) return true;
  return terminated && looksLikeFilePath(mention);
};

export type ComposerMentionHighlight = {
  start: number;
  end: number;
  kind: 'agent' | 'file';
};

export const collectComposerMentionHighlights = (
  text: string,
  {
    confirmedValues,
    agentNames,
  }: {
    confirmedValues: ReadonlySet<string>;
    agentNames: ReadonlySet<string>;
  },
): ComposerMentionHighlight[] => {
  if (!text.includes('@')) return [];
  const ranges: ComposerMentionHighlight[] = [];
  const mentionRegex = /@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const full = match[0];
    const mention = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
    const start = match.index;
    const end = start + full.length;
    const charBefore = start > 0 ? text[start - 1] : null;
    const isBoundary = !charBefore || MENTION_BOUNDARY_BEFORE.test(charBefore);
    if (!isBoundary || mention.length === 0) continue;
    if (mention.startsWith('session:')) continue;
    if (agentNames.has(mention.toLowerCase())) {
      ranges.push({ start, end, kind: 'agent' });
      continue;
    }
    const mentionEnd = start + 1 + mention.length;
    const terminated = isFileMentionTokenTerminated(text, mentionEnd);
    if (shouldHighlightFileMention({
      mention,
      confirmed: confirmedValues.has(mention),
      terminated,
    })) {
      ranges.push({ start, end, kind: 'file' });
    }
  }
  return ranges;
};

export type ConfirmableFileMention = {
  kind: 'file' | 'directory';
  value: string;
  start: number;
  end: number;
};

export const collectConfirmableFileMentions = (
  text: string,
  {
    agentNames,
    includeUnterminatedPastedReferences = false,
  }: {
    agentNames?: ReadonlySet<string>;
    includeUnterminatedPastedReferences?: boolean;
  } = {},
): ConfirmableFileMention[] => {
  if (!text.includes('@')) return [];
  const mentions: ConfirmableFileMention[] = [];
  const mentionRegex = /@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const mention = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
    const start = match.index;
    const charBefore = start > 0 ? text[start - 1] : null;
    const isBoundary = !charBefore || MENTION_BOUNDARY_BEFORE.test(charBefore);
    if (!isBoundary || !mention || mention.startsWith('session:')) continue;
    if (agentNames?.has(mention.toLowerCase())) continue;
    const end = start + 1 + mention.length;
    const terminated = isFileMentionTokenTerminated(text, end);
    const pastedReference = includeUnterminatedPastedReferences && looksLikePastedFileReference(mention);
    if (!terminated && !pastedReference) continue;
    if (!looksLikeFilePath(mention) && !pastedReference) continue;
    mentions.push({
      kind: mention.endsWith('/') || mention.endsWith('\\') ? 'directory' : 'file',
      value: mention,
      start,
      end,
    });
  }
  return mentions;
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
