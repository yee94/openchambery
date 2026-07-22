import type { GitBranch } from '@/lib/api/types';

export type GitBranchStartupStorage = Pick<Storage, 'getItem' | 'setItem'>;

const CACHE_VERSION = 2;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const normalizeGitBranchDirectory = (directory: string | null | undefined): string | null => {
  const trimmed = directory?.trim().replace(/\\/g, '/');
  if (!trimmed) return null;
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
};

const isGitBranch = (value: unknown): value is GitBranch => (
  isRecord(value)
  && Array.isArray(value.all)
  && value.all.every((branch) => typeof branch === 'string')
  && typeof value.current === 'string'
  && isRecord(value.branches)
);

const scopeKey = (transport: string, directory: string): string => JSON.stringify([transport, directory]);
type BranchCache = { version: 2; entries: Record<string, GitBranch> };

const isBranchCache = (value: BranchCache | Record<string, unknown>): value is BranchCache => (
  'version' in value && value.version === CACHE_VERSION && isRecord(value.entries)
);

const parseCache = (raw: string | null): BranchCache | Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version === CACHE_VERSION && isRecord(parsed.entries)) {
      return { version: CACHE_VERSION, entries: parsed.entries as Record<string, GitBranch> };
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeCache = (storage: GitBranchStartupStorage, cache: BranchCache): void => {
  try {
    storage.setItem('oc.gitBranchCache', JSON.stringify(cache));
  } catch {
    // Storage availability does not affect the live Query result.
  }
};

/** Reads the current transport snapshot and converts the one-time directory cache on its first read. */
export const readGitBranchStartupSnapshot = (directory: string | null | undefined, transport: string, storage: GitBranchStartupStorage): GitBranch | null => {
  const normalizedDirectory = normalizeGitBranchDirectory(directory);
  if (!normalizedDirectory || !transport) return null;
  let raw: string | null;
  try {
    raw = storage.getItem('oc.gitBranchCache');
  } catch {
    return null;
  }
  const parsed = parseCache(raw);
  if (!parsed) return null;
  if (isBranchCache(parsed)) {
    return isGitBranch(parsed.entries[scopeKey(transport, normalizedDirectory)])
      ? parsed.entries[scopeKey(transport, normalizedDirectory)]
      : null;
  }
  const entries: Record<string, GitBranch> = {};
  for (const [legacyDirectory, branches] of Object.entries(parsed)) {
    const normalizedLegacyDirectory = normalizeGitBranchDirectory(legacyDirectory);
    if (normalizedLegacyDirectory && isGitBranch(branches)) entries[scopeKey(transport, normalizedLegacyDirectory)] = branches;
  }
  const migrated: BranchCache = { version: CACHE_VERSION, entries };
  writeCache(storage, migrated);
  return entries[scopeKey(transport, normalizedDirectory)] ?? null;
};

export const writeGitBranchStartupSnapshot = (directory: string | null | undefined, transport: string, branches: GitBranch, storage: GitBranchStartupStorage): void => {
  const normalizedDirectory = normalizeGitBranchDirectory(directory);
  if (!normalizedDirectory || !transport || !isGitBranch(branches)) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem('oc.gitBranchCache');
  } catch {
    return;
  }
  const parsed = parseCache(raw);
  const entries = parsed && isBranchCache(parsed) ? parsed.entries : {};
  writeCache(storage, { version: CACHE_VERSION, entries: { ...entries, [scopeKey(transport, normalizedDirectory)]: branches } });
};
