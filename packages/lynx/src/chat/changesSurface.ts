/**
 * Cap MobileChangesSurface data path — `GET /api/git/status?directory=`.
 * failure ≠ empty changes success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxGitChangeEntry = {
  path: string;
  status: string;
  staged: boolean;
};

/** Cap ChangesPanel staged vs unstaged groups (phone MobileChangesSurface). */
export const partitionLynxGitChangeEntries = (
  entries: readonly LynxGitChangeEntry[],
): { staged: LynxGitChangeEntry[]; unstaged: LynxGitChangeEntry[] } => {
  const staged: LynxGitChangeEntry[] = [];
  const unstaged: LynxGitChangeEntry[] = [];
  for (const entry of entries) {
    if (entry.staged) staged.push(entry);
    else unstaged.push(entry);
  }
  return { staged, unstaged };
};


export type LynxGitDiffStat = {
  insertions: number;
  deletions: number;
};

export type LynxGitStatusResult =
  | {
      status: 'ok';
      directory: string;
      branch: string | null;
      entries: LynxGitChangeEntry[];
      /** Cap `GitStatus.diffStats` — path → +/- counts for ChangeRow chips. */
      diffStats: Record<string, LynxGitDiffStat>;
      /** Cap `GitStatus.ahead` — commits ahead of tracking (for pull-if-behind / push). */
      ahead: number;
      /** Cap `GitStatus.behind` — commits behind tracking (triggers Cap pull before push). */
      behind: number;
      /** Cap `GitStatus.tracking` e.g. `origin/main`. */
      tracking: string | null;
    }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const pushFiles = (
  target: LynxGitChangeEntry[],
  files: unknown,
  staged: boolean,
  fallbackStatus: string,
) => {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    if (typeof file === 'string' && file.trim()) {
      target.push({ path: file.trim(), status: fallbackStatus, staged });
      continue;
    }
    if (!file || typeof file !== 'object') continue;
    const record = file as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim()
      ? record.path.trim()
      : typeof record.file === 'string' && record.file.trim()
        ? record.file.trim()
        : '';
    if (!path) continue;
    const status = typeof record.status === 'string' && record.status.trim()
      ? record.status.trim()
      : fallbackStatus;
    target.push({ path, status, staged });
  }
};


const parseDiffStats = (raw: unknown): Record<string, LynxGitDiffStat> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LynxGitDiffStat> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!path.trim() || !value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const insertions = typeof record.insertions === 'number' && Number.isFinite(record.insertions)
      ? Math.max(0, Math.floor(record.insertions))
      : 0;
    const deletions = typeof record.deletions === 'number' && Number.isFinite(record.deletions)
      ? Math.max(0, Math.floor(record.deletions))
      : 0;
    out[path] = { insertions, deletions };
  }
  return out;
};


const parseNonNegInt = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
};

/** Cap status ahead/behind/tracking — used by commit→push pull-if-behind. */
export const parseLynxGitSyncCounts = (payload: Record<string, unknown>): {
  ahead: number;
  behind: number;
  tracking: string | null;
} => {
  const tracking = typeof payload.tracking === 'string' && payload.tracking.trim()
    ? payload.tracking.trim()
    : null;
  return {
    ahead: parseNonNegInt(payload.ahead),
    behind: parseNonNegInt(payload.behind),
    tracking,
  };
};

/** Cap `GET /api/git/status?directory=` (gitApiHttp). */
export const loadLynxGitStatus = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  options?: { signal?: AbortSignal; mode?: 'light' },
): Promise<LynxGitStatusResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = directory?.trim();
  if (!trimmed) return { status: 'no-directory' };
  try {
    const params = new URLSearchParams({ directory: trimmed });
    if (options?.mode) params.set('mode', options.mode);
    const response = await runtimeFetch(`/api/git/status?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/status failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = asRecord(await response.json());
    const branch = typeof payload.branch === 'string'
      ? payload.branch
      : typeof payload.currentBranch === 'string'
        ? payload.currentBranch
        : null;
    const entries: LynxGitChangeEntry[] = [];
    pushFiles(entries, payload.stagedFiles ?? payload.staged, true, 'staged');
    pushFiles(entries, payload.unstagedFiles ?? payload.unstaged ?? payload.files, false, 'modified');
    pushFiles(entries, payload.untrackedFiles ?? payload.untracked, false, 'untracked');
    // Cap sometimes returns a flat `changes` array with staged flags.
    if (Array.isArray(payload.changes) && entries.length === 0) {
      for (const change of payload.changes) {
        if (!change || typeof change !== 'object') continue;
        const record = change as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        if (!path) continue;
        entries.push({
          path,
          status: typeof record.status === 'string' ? record.status : 'modified',
          staged: record.staged === true,
        });
      }
    }
    const diffStats = parseDiffStats(payload.diffStats);
    const syncCounts = parseLynxGitSyncCounts(payload);
    return {
      status: 'ok',
      directory: trimmed,
      branch,
      entries,
      diffStats,
      ahead: syncCounts.ahead,
      behind: syncCounts.behind,
      tracking: syncCounts.tracking,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};


const gitQuery = (
  directory: string,
  extra?: Record<string, string | undefined>,
): string => {
  const params = new URLSearchParams({ directory });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
  }
  return params.toString();
};

export type LynxGitFileDiffResult =
  | {
      status: 'ok';
      path: string;
      staged: boolean;
      original: string;
      modified: string;
      isBinary: boolean;
      /** Unified patch from `/api/git/diff` when available. */
      unifiedDiff: string | null;
    }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

/**
 * Cap MobileChangesSurface file diff — `GET /api/git/file-diff` (+ optional
 * unified `GET /api/git/diff` for turn/patch text).
 */
export const loadLynxGitFileDiff = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  path: string,
  options?: { staged?: boolean; signal?: AbortSignal },
): Promise<LynxGitFileDiffResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return { status: 'failed', error: new Error('path is required to fetch git file diff') };
  }
  const staged = options?.staged === true;
  try {
    const fileDiffQs = gitQuery(trimmedDir, {
      path: trimmedPath,
      staged: staged ? 'true' : undefined,
    });
    const fileDiffRes = await runtimeFetch(`/api/git/file-diff?${fileDiffQs}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (fileDiffRes.status === 0) return { status: 'no-runtime' };
    if (!fileDiffRes.ok) {
      return {
        status: 'failed',
        error: new Error(`git/file-diff failed (${fileDiffRes.status})`),
        httpStatus: fileDiffRes.status,
      };
    }
    const payload = asRecord(await fileDiffRes.json());
    const original = typeof payload.original === 'string' ? payload.original : '';
    const modified = typeof payload.modified === 'string' ? payload.modified : '';
    const isBinary = payload.isBinary === true;

    let unifiedDiff: string | null = null;
    try {
      const diffQs = gitQuery(trimmedDir, {
        path: trimmedPath,
        staged: staged ? 'true' : undefined,
      });
      const diffRes = await runtimeFetch(`/api/git/diff?${diffQs}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      });
      if (diffRes.ok) {
        const diffPayload = asRecord(await diffRes.json());
        if (typeof diffPayload.diff === 'string') unifiedDiff = diffPayload.diff;
      }
    } catch {
      // Unified turn-diff is best-effort; file-diff alone is enough for preview.
    }

    return {
      status: 'ok',
      path: trimmedPath,
      staged,
      original,
      modified,
      isBinary,
      unifiedDiff,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export type LynxGitMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const postGitJson = async (
  runtimeFetch: LynxRuntimeFetch,
  path: string,
  directory: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  try {
    const qs = gitQuery(directory);
    const response = await runtimeFetch(`${path}?${qs}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const payload = asRecord(await response.json().catch(() => null));
      const message = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `${path} failed (${response.status})`;
      return { status: 'failed', error: new Error(message), httpStatus: response.status };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `POST /api/git/commit` — MobileChangesSurface CommitSection. */
export const commitLynxGitChanges = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  message: string,
  options?: { addAll?: boolean; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return { status: 'failed', error: new Error('commit message required') };
  }
  return postGitJson(runtimeFetch, '/api/git/commit', trimmedDir, {
    message: trimmedMessage,
    addAll: options?.addAll ?? false,
  }, options);
};

export type LynxGitSyncAction = 'fetch' | 'pull' | 'push';

/**
 * Cap MobileChangesSurface SyncActions — clear HTTP endpoints exist:
 * `POST /api/git/fetch|pull|push`.
 */
export const syncLynxGit = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  action: LynxGitSyncAction,
  options?: { remote?: string; branch?: string; rebase?: boolean; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const body: Record<string, unknown> = {};
  if (options?.remote) body.remote = options.remote;
  if (options?.branch) body.branch = options.branch;
  // Cap MobileChangesSurface pull-if-behind passes rebase: true on gitPull.
  if (action === 'pull' && options?.rebase === true) body.rebase = true;
  return postGitJson(runtimeFetch, `/api/git/${action}`, trimmedDir, body, options);
};

/**
 * Cap `POST /api/git/stage` — MobileChangesSurface moveChangePaths('stage').
 * Body: `{ paths: string[] }`. Failure ≠ fake-success.
 */
export const stageLynxGitFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  paths: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('path is required to stage git changes') };
  }
  return postGitJson(runtimeFetch, '/api/git/stage', trimmedDir, { paths: cleaned }, options);
};

/**
 * Cap `POST /api/git/unstage` — MobileChangesSurface moveChangePaths('unstage').
 * Body: `{ paths: string[] }`. Failure ≠ fake-success.
 */
export const unstageLynxGitFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  paths: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('path is required to unstage git changes') };
  }
  return postGitJson(runtimeFetch, '/api/git/unstage', trimmedDir, { paths: cleaned }, options);
};

/**
 * Cap `POST /api/git/revert` — MobileChangesSurface handleRevertFile.
 * Body: `{ path: string, scope?: 'all' | 'working' }`. Failure ≠ fake-success.
 */
export const revertLynxGitFile = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  path: string,
  options?: { scope?: 'all' | 'working'; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return { status: 'failed', error: new Error('path is required to revert git changes') };
  }
  const body: Record<string, unknown> = { path: trimmedPath };
  if (options?.scope) body.scope = options.scope;
  return postGitJson(runtimeFetch, '/api/git/revert', trimmedDir, body, options);
};

/**
 * Cap MobileChangesSurface handleRevertAll — Promise.all of per-file revert.
 * Stops reporting the first failure (Cap also surfaces one toast). Failure ≠ fake-success.
 */
export const revertLynxGitFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  paths: readonly string[],
  options?: { scope?: 'all' | 'working'; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('path is required to revert git changes') };
  }
  for (const path of cleaned) {
    const result = await revertLynxGitFile(runtimeFetch, trimmedDir, path, options);
    if (result.status !== 'ok') return result;
  }
  return { status: 'ok' };
};

export type LynxGeneratedCommitMessage = {
  subject: string;
  highlights: string[];
};

export type LynxGenerateCommitMessageResult =
  | { status: 'ok'; message: LynxGeneratedCommitMessage }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const COMMIT_DIFF_FILE_LIMIT = 30;
const COMMIT_DIFF_TOTAL_CHAR_LIMIT = 120_000;

/** Cap magicPrompts `git.commit.generate.visible` default (no Cap store dependency). */
const LYNX_COMMIT_GENERATE_SYSTEM =
  'You are generating a Conventional Commits subject line from the diffs of the selected files.';

/** Cap magicPrompts `git.commit.generate.instructions` shape — JSON subject + highlights. */
const buildLynxCommitGenerateInstructions = (selectedFiles: readonly string[]): string => (
  `Return exactly one JSON object and nothing else. Do not include prose, markdown, explanations, or code fences.

The JSON object must have exactly this shape:
{"subject": string, "highlights": string[]}

Rules:
- subject format: <type>: <summary>
- allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert
- no scope in subject
- keep subject concise and user-facing
- highlights: 0-3 concise user-facing points
- use double quotes for all JSON strings
- do not include trailing commas or comments

Selected files:
${selectedFiles.map((file) => `- ${file}`).join('\n')}`
);

const extractLynxJsonObject = (value: string): Record<string, unknown> | null => {
  const text = value.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end -= 1) {
    if (candidate[end - 1] !== '}') continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning; models sometimes wrap JSON with prose or fences.
    }
  }
  return null;
};

const parseLynxCommitStructured = (
  structured: Record<string, unknown> | null,
): LynxGeneratedCommitMessage => {
  const subject = typeof structured?.subject === 'string' ? structured.subject.trim() : '';
  const highlights = Array.isArray(structured?.highlights)
    ? structured.highlights
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
  if (!subject) {
    throw new Error('Structured output missing subject');
  }
  return { subject, highlights };
};

const collectLynxSelectedFileDiffs = async (
  runtimeFetch: LynxRuntimeFetch,
  directory: string,
  files: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<string> => {
  const limited = files.slice(0, COMMIT_DIFF_FILE_LIMIT);
  const chunks = await Promise.all(limited.map(async (path) => {
    try {
      const [stagedRes, unstagedRes] = await Promise.all([
        runtimeFetch(`/api/git/diff?${gitQuery(directory, { path, staged: 'true' })}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: options?.signal,
        }).catch(() => null),
        runtimeFetch(`/api/git/diff?${gitQuery(directory, { path })}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: options?.signal,
        }).catch(() => null),
      ]);
      const parts: string[] = [];
      if (stagedRes?.ok) {
        const payload = asRecord(await stagedRes.json().catch(() => null));
        if (typeof payload.diff === 'string' && payload.diff.trim()) parts.push(payload.diff);
      }
      if (unstagedRes?.ok) {
        const payload = asRecord(await unstagedRes.json().catch(() => null));
        if (typeof payload.diff === 'string' && payload.diff.trim()) parts.push(payload.diff);
      }
      return parts.length > 0 ? parts.join('\n') : `--- ${path} (no textual diff available)`;
    } catch {
      return `--- ${path} (diff unavailable)`;
    }
  }));

  let total = '';
  for (const chunk of chunks) {
    if (total.length + chunk.length > COMMIT_DIFF_TOTAL_CHAR_LIMIT) {
      total += '\n[remaining diffs truncated]';
      break;
    }
    total += (total ? '\n\n' : '') + chunk;
  }
  if (files.length > limited.length) {
    total += `\n[${files.length - limited.length} more selected files omitted]`;
  }
  return total;
};

/**
 * Cap MobileChangesSurface `generateCommitMessage` — primary transport is
 * `POST /api/small-model/generate` with `purpose: 'commit'` (gitApi.ts).
 * Cap session-fallback (magic store / active chat) is **not** ported; 404 /
 * missing text fails honestly. Dead Cap gitApiHttp `/api/git/commit-message`
 * route is unused (no matching server route).
 */
export const generateLynxCommitMessage = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  files: readonly string[],
  options?: {
    preferredProviderID?: string;
    preferredModelID?: string;
    signal?: AbortSignal;
  },
): Promise<LynxGenerateCommitMessageResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = files.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('No files provided to generate commit message') };
  }
  try {
    const diffs = await collectLynxSelectedFileDiffs(runtimeFetch, trimmedDir, cleaned, options);
    const instructions = buildLynxCommitGenerateInstructions(cleaned);
    const body: Record<string, unknown> = {
      purpose: 'commit',
      system: LYNX_COMMIT_GENERATE_SYSTEM,
      prompt: `${instructions}\n\nDiffs of the selected files:\n${diffs}`,
      directory: trimmedDir,
    };
    if (options?.preferredProviderID) body.preferredProviderID = options.preferredProviderID;
    if (options?.preferredModelID) body.preferredModelID = options.preferredModelID;

    const response = await runtimeFetch('/api/small-model/generate', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    const payload = asRecord(await response.json().catch(() => null));
    if (!response.ok) {
      const message = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `small-model/generate failed (${response.status})`;
      return { status: 'failed', error: new Error(message), httpStatus: response.status };
    }
    if (typeof payload.text !== 'string') {
      return { status: 'failed', error: new Error('Malformed commit generation response'), httpStatus: response.status };
    }
    const message = parseLynxCommitStructured(extractLynxJsonObject(payload.text));
    return { status: 'ok', message };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Cap MobileChangesSurface `handleCommit({ pushAfter: true })` —
 * commit → fetch → pull-if-behind (rebase) → push-if-ahead.
 * Uses Cap `GET /api/git/status` ahead/behind (no silent skip of pull).
 * Failure ≠ fake-success (stops after first failed step).
 */
export const commitAndPushLynxGitChanges = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  message: string,
  options?: { addAll?: boolean; remote?: string; branch?: string; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  const committed = await commitLynxGitChanges(runtimeFetch, directory, message, options);
  if (committed.status !== 'ok') return committed;

  let remote = options?.remote?.trim() || undefined;
  let branch = options?.branch?.trim() || undefined;

  const fetched = await syncLynxGit(runtimeFetch, directory, 'fetch', {
    remote,
    branch,
    signal: options?.signal,
  });
  if (fetched.status !== 'ok') return fetched;

  const afterFetch = await loadLynxGitStatus(runtimeFetch, directory, {
    signal: options?.signal,
  });
  if (afterFetch.status === 'no-runtime' || afterFetch.status === 'no-directory') {
    return afterFetch;
  }
  if (afterFetch.status !== 'ok') {
    return { status: 'failed', error: afterFetch.error, httpStatus: afterFetch.httpStatus };
  }

  // Cap: trackingRemoteName from status.tracking, else caller remote.
  if (!remote && afterFetch.tracking) {
    remote = afterFetch.tracking.split('/')[0] || undefined;
  }
  if (!branch && remote && afterFetch.tracking?.startsWith(`${remote}/`)) {
    branch = afterFetch.tracking.slice(remote.length + 1) || undefined;
  }

  if (afterFetch.behind > 0) {
    const pulled = await syncLynxGit(runtimeFetch, directory, 'pull', {
      remote,
      branch,
      rebase: true,
      signal: options?.signal,
    });
    if (pulled.status !== 'ok') return pulled;
  }

  const afterPull = await loadLynxGitStatus(runtimeFetch, directory, {
    signal: options?.signal,
  });
  if (afterPull.status === 'no-runtime' || afterPull.status === 'no-directory') {
    return afterPull;
  }
  if (afterPull.status !== 'ok') {
    return { status: 'failed', error: afterPull.error, httpStatus: afterPull.httpStatus };
  }

  if (afterPull.ahead > 0) {
    return syncLynxGit(runtimeFetch, directory, 'push', {
      remote,
      branch,
      signal: options?.signal,
    });
  }

  // Cap: nothing to push after pull (already up to date).
  return { status: 'ok' };
};
