import { scoreTextAgainstQuery } from '@/lib/search/fuzzySearch';

export type FileMentionSearchHit = {
  relativePath: string;
  name?: string;
  extension?: string;
  isDirectory?: boolean;
};

export type FileMentionQueryIntent = {
  raw: string;
  search: string;
  stem: string;
  extension: string | null;
  fileIntent: boolean;
  directoryIntent: boolean;
};

const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;
const TEST_PATH_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  '__mocks__',
]);
const TEST_FILENAME_PATTERN = /\.(?:test|spec|e2e)\./i;
const STEM_ONLY_PENALTY = 0.85;
const FILE_INTENT_DIRECTORY_PENALTY = 3;
const DIRECTORY_INTENT_FILE_PENALTY = 3;
const TEST_PATH_PENALTY = 1.25;
const EXTENSION_MATCH_BONUS = -0.35;
const DIRECTORY_BASENAME_BONUS = -0.5;

export const parseFileMentionQuery = (query: string): FileMentionQueryIntent => {
  const raw = query.trim().replace(/^\.\//, '').replace(/^[/\\]+/, '').toLowerCase();
  const directoryIntent = /[/\\]$/.test(raw);
  const search = raw.replace(/[/\\]+$/, '');
  const lastSeparator = Math.max(search.lastIndexOf('/'), search.lastIndexOf('\\'));
  const lastSegment = lastSeparator >= 0 ? search.slice(lastSeparator + 1) : search;
  const extensionMatch = lastSegment.match(FILE_EXTENSION_PATTERN);
  const fileIntent = !directoryIntent && extensionMatch !== null;
  const extension = fileIntent && extensionMatch ? extensionMatch[0].slice(1) : null;
  const stem = fileIntent && extensionMatch
    ? search.slice(0, search.length - extensionMatch[0].length)
    : search;
  return { raw, search, stem, extension, fileIntent, directoryIntent };
};

/** Query sent to the file-search backend after stripping intent suffixes. */
export const resolveFileMentionSearchQuery = (query: string): string => {
  const parsed = parseFileMentionQuery(query);
  if ((parsed.fileIntent || parsed.directoryIntent) && parsed.stem) {
    return parsed.stem;
  }
  return parsed.search;
};

export const isTestFileMentionPath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => TEST_PATH_SEGMENTS.has(segment))) return true;
  const name = segments.at(-1) ?? normalized;
  return TEST_FILENAME_PATTERN.test(name);
};

const normalizeRelPath = (relativePath: string): string => (
  relativePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
);

const hitName = (hit: FileMentionSearchHit, path: string): string => (
  (hit.name || path.split('/').filter(Boolean).pop() || path).toLowerCase()
);

const bestScore = (left: number | null, right: number | null): number | null => {
  if (left === null && right === null) return null;
  return Math.min(left ?? Number.POSITIVE_INFINITY, right ?? Number.POSITIVE_INFINITY);
};

const scoreHit = (hit: FileMentionSearchHit, parsed: FileMentionQueryIntent): number | null => {
  const path = normalizeRelPath(hit.relativePath);
  const name = hitName(hit, path);
  const isDirectory = hit.isDirectory === true;
  const fullBest = bestScore(
    scoreTextAgainstQuery(path, parsed.search),
    scoreTextAgainstQuery(name, parsed.search),
  );

  let score: number;
  if (fullBest !== null) {
    score = fullBest;
  } else if (parsed.stem && parsed.stem !== parsed.search) {
    const stemBest = bestScore(
      scoreTextAgainstQuery(path, parsed.stem),
      scoreTextAgainstQuery(name, parsed.stem),
    );
    if (stemBest === null) return null;
    score = stemBest + STEM_ONLY_PENALTY;
  } else {
    return null;
  }

  if (parsed.fileIntent && isDirectory) score += FILE_INTENT_DIRECTORY_PENALTY;
  if (parsed.directoryIntent && !isDirectory) score += DIRECTORY_INTENT_FILE_PENALTY;
  if (parsed.fileIntent && !isDirectory && parsed.extension && hit.extension === parsed.extension) {
    score += EXTENSION_MATCH_BONUS;
  }
  if (parsed.directoryIntent && isDirectory && name === parsed.stem) {
    score += DIRECTORY_BASENAME_BONUS;
  }
  if (isTestFileMentionPath(path) && !isTestFileMentionPath(parsed.search)) {
    score += TEST_PATH_PENALTY;
  }
  return score;
};

/**
 * Rank mixed file/directory hits for `@` mention search.
 * Unmatched candidates are dropped. Lower score is better.
 */
export const rankFileMentionSearch = <T extends FileMentionSearchHit>(
  hits: readonly T[],
  query: string,
  options?: { limit?: number },
): T[] => {
  const limit = options?.limit ?? 20;
  const parsed = parseFileMentionQuery(query);
  if (!parsed.search && !parsed.stem) {
    return hits.slice(0, limit);
  }

  const scored = hits.flatMap((item) => {
    const score = scoreHit(item, parsed);
    if (score === null) return [];
    return [{ item, score, sortKey: normalizeRelPath(item.relativePath) }];
  });

  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    if (left.sortKey.length !== right.sortKey.length) return left.sortKey.length - right.sortKey.length;
    return left.sortKey.localeCompare(right.sortKey, undefined, { sensitivity: 'accent' });
  });

  return scored.slice(0, limit).map(({ item }) => item);
};
