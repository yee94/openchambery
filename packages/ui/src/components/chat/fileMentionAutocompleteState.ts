import type { Session } from '@/lib/opencode/v2-types';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import { isNpmScopedPackageMention, rankFileMentionSearch, type FileMentionSearchHit } from '@/lib/search/fileMentionSearch';
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
  !isNpmScopedPackageMention(mention)
  && (mention.includes('/') || mention.includes('\\') || mention.includes('.'))
);

export const looksLikePastedFileReference = (mention: string): boolean => {
  if (!looksLikeFilePath(mention)) return false;
  const normalized = mention.replace(/\\/g, '/');
  if (normalized.endsWith('/')) return true;
  const lastSegment = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return FILE_EXTENSION_PATTERN.test(lastSegment);
};

const isMultiSegmentAbsolutePath = (value: string): boolean => {
  const normalized = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.slice(3).includes('/');
  if (normalized.startsWith('//')) return normalized.replace(/^\/+/, '').includes('/');
  if (normalized.startsWith('/')) return normalized.slice(1).includes('/');
  return false;
};

type ScannedAtMention = {
  value: string;
  /** Exclusive end of `@${value}` after trailing punctuation is stripped. */
  end: number;
  /** Exclusive end of the raw token, including trailing punctuation the highlighter paints. */
  highlightEnd: number;
};

const findLongestConfirmedSpacedMention = (
  text: string,
  at: number,
  confirmedValues: ReadonlySet<string> | undefined,
): ScannedAtMention | null => {
  if (!confirmedValues || confirmedValues.size === 0 || text[at] !== '@') return null;
  const rest = text.slice(at + 1);
  let best: string | null = null;
  for (const value of confirmedValues) {
    if (!value || (!value.includes(' ') && !value.includes('\t'))) continue;
    if (!rest.startsWith(value)) continue;
    const next = text[at + 1 + value.length];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (!best || value.length > best.length) best = value;
  }
  if (!best) return null;
  const end = at + 1 + best.length;
  return { value: best, end, highlightEnd: end };
};

/**
 * A pasted absolute path may contain spaces in the filename
 * (`/Users/.../今天我们穿越去哪？ - Slidev.pdf`). Extend only while the token
 * stays a multi-segment absolute path and stop at the first extension or
 * trailing slash, so following prose is not swallowed.
 */
const readSpacedPastedFileMention = (text: string, at: number): ScannedAtMention | null => {
  const rest = text.slice(at + 1);
  const firstBreak = rest.search(/\s/);
  const firstToken = firstBreak === -1 ? rest : rest.slice(0, firstBreak);
  if (!firstToken || /[\r\n]/.test(firstToken) || !isMultiSegmentAbsolutePath(firstToken)) return null;

  let end = at + 1 + firstToken.length;
  let value = firstToken;
  if (looksLikePastedFileReference(value)) return { value, end, highlightEnd: end };

  while (end < text.length && /[ \t]/.test(text[end])) {
    let next = end + 1;
    while (next < text.length && !/\s/.test(text[next])) next += 1;
    if (next === end + 1) break;
    const extended = text.slice(at + 1, next);
    if (extended.length > 4096) break;
    value = extended;
    end = next;
    if (looksLikePastedFileReference(value)) return { value, end, highlightEnd: end };
  }
  return null;
};

const readWhitespaceMention = (text: string, at: number): ScannedAtMention | null => {
  const match = /^([^\s]+)/.exec(text.slice(at + 1));
  const raw = match?.[1] ?? '';
  if (!raw) return null;
  const value = raw.trim().replace(/[),.;:!?`"'>]+$/g, '');
  if (!value) return null;
  return { value, end: at + 1 + value.length, highlightEnd: at + 1 + raw.length };
};

const scanAtMentions = (
  text: string,
  {
    confirmedValues,
    allowSpacedPastedPaths = false,
  }: {
    confirmedValues?: ReadonlySet<string>;
    allowSpacedPastedPaths?: boolean;
  },
): Array<ScannedAtMention & { start: number }> => {
  const found: Array<ScannedAtMention & { start: number }> = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const charBefore = at > 0 ? text[at - 1] : null;
    const isBoundary = !charBefore || MENTION_BOUNDARY_BEFORE.test(charBefore);
    if (!isBoundary) {
      index = at + 1;
      continue;
    }
    const token = findLongestConfirmedSpacedMention(text, at, confirmedValues)
      ?? (allowSpacedPastedPaths ? readSpacedPastedFileMention(text, at) : null)
      ?? readWhitespaceMention(text, at);
    if (!token) {
      index = at + 1;
      continue;
    }
    found.push({ start: at, ...token });
    index = Math.max(token.highlightEnd, token.end, at + 1);
  }
  return found;
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
  for (const token of scanAtMentions(text, { confirmedValues })) {
    const { start, value: mention, end, highlightEnd } = token;
    if (mention.startsWith('session:')) continue;
    if (agentNames.has(mention.toLowerCase())) {
      ranges.push({ start, end: highlightEnd, kind: 'agent' });
      continue;
    }
    const terminated = isFileMentionTokenTerminated(text, end);
    if (shouldHighlightFileMention({
      mention,
      confirmed: confirmedValues.has(mention),
      terminated,
    })) {
      ranges.push({ start, end: highlightEnd, kind: 'file' });
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
    confirmedValues,
  }: {
    agentNames?: ReadonlySet<string>;
    includeUnterminatedPastedReferences?: boolean;
    /** Already-confirmed paths, including filenames that contain spaces. */
    confirmedValues?: ReadonlySet<string>;
  } = {},
): ConfirmableFileMention[] => {
  if (!text.includes('@')) return [];
  const mentions: ConfirmableFileMention[] = [];
  for (const token of scanAtMentions(text, {
    confirmedValues,
    allowSpacedPastedPaths: includeUnterminatedPastedReferences,
  })) {
    const { start, value: mention, end } = token;
    if (!mention || mention.startsWith('session:')) continue;
    if (agentNames?.has(mention.toLowerCase())) continue;
    const spaced = mention.includes(' ') || mention.includes('\t');
    const terminated = isFileMentionTokenTerminated(text, end);
    const pastedReference = includeUnterminatedPastedReferences && (spaced || looksLikePastedFileReference(mention));
    const confirmed = confirmedValues?.has(mention) === true;
    if (!terminated && !pastedReference && !confirmed) continue;
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

/** Session mention row; `directory` is required when the caller supplies it (e.g. index snapshot). */
export type SessionMentionCandidate = Session & { directory?: string };

/**
 * Filter/sort session mention candidates while preserving the caller row type
 * (so a required `directory: string` from index-backed rows stays required).
 */
export const getVisibleSessionMentionCandidates = <T extends SessionMentionCandidate>({
    sessions,
    currentSessionId,
    searchQuery,
}: {
    sessions: readonly T[];
    currentSessionId: string | null;
    searchQuery: string;
}): T[] => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return sessions
        .filter((session) => session.id !== currentSessionId)
        .filter((session) => !normalizedQuery || `${session.title ?? ''} ${session.id}`.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
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
