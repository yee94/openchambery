

import type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  GeneratedCommitMessage,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationResult,
  CreateGitCommitOptions,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitPullOptions,
  GitStashEntry,
  GitLogOptions,
  GitLogResponse,
  GitCommitFilesResponse,
  CommitFileDiffResponse,
  GitIdentityProfile,
  GitIdentitySummary,
  DiscoveredGitCredential,
  MergeConflictDetails,
  CheckoutCommitResponse,
  CherryPickResponse,
  RevertCommitResponse,
  ResetToCommitResponse,
} from './api/types';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from './runtime-switch';
import { getRuntimeUrlResolver } from './runtime-url';

const API_BASE = '/api/git';
const GIT_STATUS_CACHE_TTL_MS = 1200;
const GIT_REPO_CHECK_CACHE_TTL_MS = 5000;
// Discovery GETs fan out across every sidebar project. Cap concurrent sockets
// so long-poll + worktree listing cannot starve send-path reads (settings /
// createWithPrompt) under Chromium's ~6 HTTP/1.1 connections per origin.
const GIT_DISCOVERY_NETWORK_CONCURRENCY = 2;
const GIT_DISCOVERY_CACHE_TTL_MS = 5000;
const QUEUE_ACTIVATION_PATH = `${API_BASE}/worktrees/queue-activation`;
const MESSAGE_QUEUE_ACTIVATION_PENDING = 'message_queue_activation_pending';
const WORKTREE_LIFECYCLE_BUSY = 'worktree_lifecycle_busy';
const WORKTREE_ACTIVATION_STALE = 'worktree_activation_stale';
const QUEUE_ACTIVATION_REPAIR_ATTEMPT_TIMEOUT_MS = 5_000;
const QUEUE_ACTIVATION_REPAIR_BUDGET_MS = 30_000;
const QUEUE_ACTIVATION_REPAIR_BACKOFF_MS = [0, 500, 1_000, 2_000, 4_000, 8_000, 14_000] as const;
const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
const gitStatusCacheVersions = new Map<string, number>();
const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
const gitRepoInFlight = new Map<string, Promise<boolean>>();
const gitPrimaryRootCache = new Map<string, { value: { root: string }; expiresAt: number }>();
const gitPrimaryRootInFlight = new Map<string, Promise<{ root: string }>>();
const gitWorktreesCache = new Map<string, { value: GitWorktreeInfo[]; expiresAt: number }>();
const gitWorktreesInFlight = new Map<string, Promise<GitWorktreeInfo[]>>();
const pendingQueueActivationRepairs = new Set<string>();
let gitDiscoveryNetworkActive = 0;
const gitDiscoveryNetworkWaiters: Array<() => void> = [];

const acquireGitDiscoveryNetworkSlot = (): Promise<void> => {
  if (gitDiscoveryNetworkActive < GIT_DISCOVERY_NETWORK_CONCURRENCY) {
    gitDiscoveryNetworkActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    gitDiscoveryNetworkWaiters.push(resolve);
  });
};

const releaseGitDiscoveryNetworkSlot = (): void => {
  const next = gitDiscoveryNetworkWaiters.shift();
  if (next) {
    next();
    return;
  }
  gitDiscoveryNetworkActive = Math.max(0, gitDiscoveryNetworkActive - 1);
};

/** Shared gate for runtime-backed discovery calls that bypass gitApiHttp helpers. */
export const withGitDiscoveryNetworkSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  await acquireGitDiscoveryNetworkSlot();
  try {
    return await task();
  } finally {
    releaseGitDiscoveryNetworkSlot();
  }
};

const normalizeDirectoryKey = (directory: string): string => directory.trim();
const getStatusCacheKey = (directory: string, mode?: 'light'): string =>
  mode === 'light' ? `${normalizeDirectoryKey(directory)}::light` : normalizeDirectoryKey(directory);

const getStatusCacheVersion = (directory: string): number =>
  gitStatusCacheVersions.get(normalizeDirectoryKey(directory)) ?? 0;

const invalidateGitStatusCache = (directory: string): void => {
  const key = normalizeDirectoryKey(directory);
  gitStatusCacheVersions.set(key, getStatusCacheVersion(directory) + 1);
  for (const cacheKey of Array.from(gitStatusCache.keys())) {
    if (cacheKey === key || cacheKey.startsWith(`${key}::`)) {
      gitStatusCache.delete(cacheKey);
    }
  }
  for (const cacheKey of Array.from(gitStatusInFlight.keys())) {
    if (cacheKey === key || cacheKey.startsWith(`${key}::`)) {
      gitStatusInFlight.delete(cacheKey);
    }
  }
};

function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const query: Record<string, string | number | boolean | undefined> = { ...params };
  if (directory) query.directory = directory;

  return getRuntimeUrlResolver().api(path, query);
}

const writeGitDiscoveryCaches = (
  directory: string,
  isGitRepository: boolean,
  primaryRoot: string | null,
): void => {
  const key = normalizeDirectoryKey(directory);
  if (!key) return;
  const expiresAt = Date.now() + GIT_DISCOVERY_CACHE_TTL_MS;
  gitRepoCache.set(key, {
    value: isGitRepository,
    expiresAt,
  });
  const root = typeof primaryRoot === 'string' && primaryRoot
    ? primaryRoot
    : directory;
  gitPrimaryRootCache.set(key, {
    value: { root },
    expiresAt,
  });
};

export type GitDiscoverEntry = {
  isGitRepository: boolean;
  primaryRoot: string | null;
};

/**
 * Batch-discover git repo + primary root for many directories in one request.
 * Seeds gitRepoCache / gitPrimaryRootCache so subsequent single lookups hit TTL
 * cache with zero network. Falls back to per-directory check + primary-root when
 * the batch endpoint is missing (501) or fails.
 */
export async function discoverGitRepositories(
  directories: string[],
): Promise<Map<string, GitDiscoverEntry>> {
  const unique = Array.from(
    new Set(
      directories
        .map((directory) => normalizeDirectoryKey(directory))
        .filter(Boolean),
    ),
  );
  const result = new Map<string, GitDiscoverEntry>();
  if (unique.length === 0) {
    return result;
  }

  const now = Date.now();
  const missing: string[] = [];
  for (const directory of unique) {
    const repoCached = gitRepoCache.get(directory);
    const rootCached = gitPrimaryRootCache.get(directory);
    if (
      repoCached && repoCached.expiresAt > now
      && rootCached && rootCached.expiresAt > now
    ) {
      result.set(directory, {
        isGitRepository: repoCached.value,
        primaryRoot: rootCached.value.root,
      });
      continue;
    }
    missing.push(directory);
  }

  if (missing.length === 0) {
    return result;
  }

  const applyBatchEntries = (
    entries: Array<{
      directory?: unknown;
      isGitRepository?: unknown;
      primaryRoot?: unknown;
    }>,
  ): void => {
    for (const entry of entries) {
      const directory = typeof entry.directory === 'string'
        ? normalizeDirectoryKey(entry.directory)
        : '';
      if (!directory) continue;
      const isGitRepository = Boolean(entry.isGitRepository);
      const primaryRoot = typeof entry.primaryRoot === 'string' && entry.primaryRoot
        ? entry.primaryRoot
        : null;
      writeGitDiscoveryCaches(directory, isGitRepository, primaryRoot);
      result.set(directory, { isGitRepository, primaryRoot });
    }
  };

  const discoverViaSingles = async (dirs: string[]): Promise<void> => {
    await Promise.all(dirs.map(async (directory) => {
      try {
        const [isGitRepository, primary] = await Promise.all([
          checkIsGitRepository(directory),
          resolveGitPrimaryRoot(directory).then((value) => value.root).catch(() => directory),
        ]);
        writeGitDiscoveryCaches(directory, isGitRepository, isGitRepository ? primary : null);
        result.set(directory, {
          isGitRepository,
          primaryRoot: isGitRepository ? primary : null,
        });
      } catch {
        writeGitDiscoveryCaches(directory, false, null);
        result.set(directory, { isGitRepository: false, primaryRoot: null });
      }
    }));
  };

  try {
    await withGitDiscoveryNetworkSlot(async () => {
      const params = new URLSearchParams();
      for (const directory of missing) {
        params.append('directories', directory);
      }
      const base = getRuntimeUrlResolver().api(`${API_BASE}/discover`);
      const qs = params.toString();
      const url = qs
        ? (base.includes('?') ? `${base}&${qs}` : `${base}?${qs}`)
        : base;
      const response = await runtimeFetch(url);
      if (response.status === 501 || !response.ok) {
        throw new Error(
          `Batch git discover unavailable: ${response.status} ${response.statusText}`,
        );
      }
      const payload = await response.json().catch(() => null);
      const entries = Array.isArray(payload) ? payload : [];
      if (entries.length === 0 && missing.length > 0) {
        throw new Error('Batch git discover returned empty payload');
      }
      applyBatchEntries(entries);
    });
  } catch {
    // Batch failed / 501 / network — fall back below.
  }

  // Fill any directories the batch omitted or that never ran (after slot release
  // so single primary-root lookups do not nest under the batch slot).
  const stillMissing = missing.filter((directory) => !result.has(directory));
  if (stillMissing.length > 0) {
    await discoverViaSingles(stillMissing);
  }

  return result;
}

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const key = normalizeDirectoryKey(directory);
  const now = Date.now();
  const cached = gitRepoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitRepoInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/check`, directory));
    if (!response.ok) {
      throw new Error(`Failed to check git repository: ${response.statusText}`);
    }
    const data = await response.json();
    const isGitRepository = Boolean(data.isGitRepository);
    gitRepoCache.set(key, {
      value: isGitRepository,
      expiresAt: Date.now() + GIT_REPO_CHECK_CACHE_TTL_MS,
    });
    return isGitRepository;
  })();

  gitRepoInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitRepoInFlight.get(key) === task) {
      gitRepoInFlight.delete(key);
    }
  }
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus> {
  const mode = options?.mode;
  const key = getStatusCacheKey(directory, mode);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitStatusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const cacheVersion = getStatusCacheVersion(directory);
    const response = await runtimeFetch(buildUrl(`${API_BASE}/status`, directory, mode ? { mode } : undefined));
    if (!response.ok) {
      throw new Error(`Failed to get git status: ${response.statusText}`);
    }
    const payload = await response.json() as GitStatus;
    if (getStatusCacheVersion(directory) === cacheVersion) {
      gitStatusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
    }
    return payload;
  })();

  gitStatusInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitStatusInFlight.get(key) === task) {
      gitStatusInFlight.delete(key);
    }
  }
}

export async function resolveGitPrimaryRoot(directory: string): Promise<{ root: string }> {
  const key = normalizeDirectoryKey(directory);
  const now = Date.now();
  const cached = gitPrimaryRootCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = gitPrimaryRootInFlight.get(key);
  if (inFlight) return inFlight;

  const task = withGitDiscoveryNetworkSlot(async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/primary-root`, directory));
    if (!response.ok) {
      throw new Error(`Failed to resolve git primary root: ${response.statusText}`);
    }
    const payload = await response.json().catch(() => ({})) as { root?: string };
    const value = { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
    gitPrimaryRootCache.set(key, {
      value,
      expiresAt: Date.now() + GIT_DISCOVERY_CACHE_TTL_MS,
    });
    return value;
  });

  gitPrimaryRootInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitPrimaryRootInFlight.get(key) === task) {
      gitPrimaryRootInFlight.delete(key);
    }
  }
}

export async function resolveGitTopLevel(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/toplevel`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git toplevel: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<{ commits: Array<{ sha: string; short: string; subject: string }> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-summaries`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shas }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get git commit summaries: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as {
    commits?: Array<{ sha?: string; short?: string; subject?: string }>;
  };
  return {
    commits: Array.isArray(payload.commits)
      ? payload.commits
          .map((entry) => ({
            sha: typeof entry.sha === 'string' ? entry.sha : '',
            short: typeof entry.short === 'string' ? entry.short : '',
            subject: typeof entry.subject === 'string' ? entry.subject : '',
          }))
          .filter((entry) => entry.sha && entry.short)
      : [],
  };
}

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> {
  const { path, staged, contextLines } = options;
  if (!path) {
    throw new Error('path is required to fetch git diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> {
  const { path, staged } = options;
  if (!path) {
    throw new Error('path is required to fetch git file diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/file-diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git file diff: ${response.statusText}`);
  }

  return response.json();
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to revert git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, scope: options?.scope }),
  });

  if (!response.ok) {
    const message = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to revert git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  await stageGitFiles(directory, [filePath]);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to stage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/stage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to stage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  await unstageGitFiles(directory, [filePath]);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to unstage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/unstage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to unstage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'stage');
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'unstage');
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'discard');
}

async function applyGitHunk(
  directory: string,
  filePath: string,
  patch: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to apply a git hunk');
  }
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('patch is required to apply a git hunk');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/apply-hunk`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, patch, action }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to apply git hunk');
  }

  invalidateGitStatusCache(directory);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktree-type`, directory));
  if (!response.ok) {
    throw new Error(`Failed to detect worktree type: ${response.statusText}`);
  }
  const data = await response.json();
  return Boolean(data.linked);
}

export async function getGitBranches(directory: string, options?: { signal?: AbortSignal }): Promise<GitBranch> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to get branches: ${response.statusText}`);
  }
  return response.json();
}

export async function deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete a branch');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete branch');
  }

  return response.json();
}

export async function deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete remote branch');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/remote-branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete remote branch');
  }

  return response.json();
}

export async function removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }> {
  const remote = payload?.remote?.trim();
  if (!remote) {
    throw new Error('remote is required to remove a remote');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to remove remote');
  }

  return response.json();
}

export async function generateCommitMessage(
  directory: string,
  files: string[],
  options?: { zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ message: GeneratedCommitMessage }> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files provided to generate commit message');
  }

  const body: Record<string, unknown> = { files };
  if (options?.zenModel) {
    body.zenModel = options.zenModel;
  }
  if (options?.providerId) {
    body.providerId = options.providerId;
  }
  if (options?.modelId) {
    body.modelId = options.modelId;
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-message`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    console.error('[git-generation][browser] http error', {
      status: response.status,
      statusText: response.statusText,
      error,
    });
    const traceSuffix = typeof error?.traceId === 'string' && error.traceId
      ? ` (traceId: ${error.traceId})`
      : '';
    throw new Error(`${error.error || 'Failed to generate commit message'}${traceSuffix}`);
  }

  const data = await response.json();

  if (!data?.message || typeof data.message !== 'object') {
    throw new Error('Malformed commit generation response');
  }

  const subject =
    typeof data.message.subject === 'string' && data.message.subject.trim().length > 0
      ? data.message.subject.trim()
      : '';

  const highlights: string[] = Array.isArray(data.message.highlights)
    ? (data.message.highlights as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => (item as string).trim())
    : [];

  return {
    message: {
      subject,
      highlights,
    },
  };
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ title: string; body: string }> {
  const { base, head, context, zenModel, providerId, modelId } = payload;
  if (!base || !head) {
    throw new Error('base and head are required');
  }

  const requestBody: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string } = { base, head };
  if (context?.trim()) {
    requestBody.context = context.trim();
  }
  if (zenModel) {
    requestBody.zenModel = zenModel;
  }
  if (providerId) {
    requestBody.providerId = providerId;
  }
  if (modelId) {
    requestBody.modelId = modelId;
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/pr-description`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to generate PR description');
  }

  const data = await response.json().catch(() => null);
  const title = typeof data?.title === 'string' ? data.title : '';
  const body = typeof data?.body === 'string' ? data.body : '';
  if (!title && !body) {
    throw new Error('Malformed PR description response');
  }
  return { title, body };
}

export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const key = normalizeDirectoryKey(directory);
  const now = Date.now();
  const cached = gitWorktreesCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = gitWorktreesInFlight.get(key);
  if (inFlight) return inFlight;

  const task = withGitDiscoveryNetworkSlot(async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to list worktrees');
    }
    const value = await response.json() as GitWorktreeInfo[];
    gitWorktreesCache.set(key, {
      value,
      expiresAt: Date.now() + GIT_DISCOVERY_CACHE_TTL_MS,
    });
    return value;
  });

  gitWorktreesInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitWorktreesInFlight.get(key) === task) {
      gitWorktreesInFlight.delete(key);
    }
  }
}

export async function validateGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/validate`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to validate worktree');
  }

  return response.json();
}

export async function getGitWorktreeBootstrapStatus(directory: string): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/bootstrap-status`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to get worktree bootstrap status');
  }
  return response.json();
}

export async function previewGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/preview`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to preview worktree');
  }

  return response.json();
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const parseGitWorktreeCreateResult = (value: unknown): GitWorktreeCreateResult | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.name) || !isNonEmptyString(candidate.path)) {
    return null;
  }
  const result: GitWorktreeCreateResult = {
    head: typeof candidate.head === 'string' ? candidate.head : '',
    name: candidate.name,
    branch: typeof candidate.branch === 'string' ? candidate.branch : '',
    path: candidate.path,
  };
  if (candidate.directoryCreated === true) {
    result.directoryCreated = true;
  }
  if (candidate.bootstrapStatus && typeof candidate.bootstrapStatus === 'object') {
    result.bootstrapStatus = candidate.bootstrapStatus as GitWorktreeCreateResult['bootstrapStatus'];
  }
  return result;
};

/**
 * Strict trusted partial-success envelope from POST /api/git/worktrees when Git
 * created the worktree but message-queue activation is still pending.
 * Never treats an arbitrary server repair descriptor as executable — only the
 * fixed queue-activation endpoint/body after validation.
 */
const parseMessageQueueActivationPending = (
  status: number,
  payload: unknown,
  projectDirectory: string,
): GitWorktreeCreateResult | null => {
  if (status !== 503 || !payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.code !== MESSAGE_QUEUE_ACTIVATION_PENDING) return null;

  const worktree = parseGitWorktreeCreateResult(body.worktree);
  if (!worktree) return null;

  const repair = body.repair;
  if (!repair || typeof repair !== 'object') return null;
  const repairBody = repair as Record<string, unknown>;
  if (repairBody.method !== 'POST' || repairBody.path !== QUEUE_ACTIVATION_PATH) return null;

  const requestBody = repairBody.body;
  if (!requestBody || typeof requestBody !== 'object') return null;
  const fields = requestBody as Record<string, unknown>;
  if (fields.projectDirectory !== projectDirectory) return null;
  if (fields.directory !== worktree.path) return null;

  return worktree;
};

const queueActivationRepairDedupeKey = (
  transport: string,
  generation: number,
  projectDirectory: string,
  worktreePath: string,
): string => `${transport}\u0000${generation}\u0000${projectDirectory}\u0000${worktreePath}`;

const waitMs = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const isRetryableQueueActivationResponse = async (response: Response): Promise<boolean> => {
  if (response.status === 409) {
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    return payload?.code === WORKTREE_LIFECYCLE_BUSY || payload?.code === WORKTREE_ACTIVATION_STALE;
  }
  if (response.status === 503) {
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    return payload?.code === MESSAGE_QUEUE_ACTIVATION_PENDING;
  }
  return false;
};

const isTerminalQueueActivationStatus = (status: number): boolean =>
  status === 400 || status === 401 || status === 403 || status === 501;

/**
 * Fire-and-forget queue activation repair. Deduped per transport + generation +
 * project/worktree path; stops when runtime/transport identity changes.
 */
const scheduleQueueActivationRepair = (projectDirectory: string, worktreePath: string): void => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const dedupeKey = queueActivationRepairDedupeKey(transport, generation, projectDirectory, worktreePath);
  if (pendingQueueActivationRepairs.has(dedupeKey)) return;
  pendingQueueActivationRepairs.add(dedupeKey);

  const isCurrentRuntime = (): boolean =>
    getRuntimeTransportIdentity() === transport && getRuntimeGeneration() === generation;

  void (async () => {
    const startedAt = Date.now();
    let attempt = 0;

    while (Date.now() - startedAt < QUEUE_ACTIVATION_REPAIR_BUDGET_MS) {
      if (!isCurrentRuntime()) return;

      const backoff = QUEUE_ACTIVATION_REPAIR_BACKOFF_MS[
        Math.min(attempt, QUEUE_ACTIVATION_REPAIR_BACKOFF_MS.length - 1)
      ] ?? 0;
      if (backoff > 0) {
        const remaining = QUEUE_ACTIVATION_REPAIR_BUDGET_MS - (Date.now() - startedAt);
        if (remaining <= 0) return;
        await waitMs(Math.min(backoff, remaining));
        if (!isCurrentRuntime()) return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), QUEUE_ACTIVATION_REPAIR_ATTEMPT_TIMEOUT_MS);
      try {
        const response = await runtimeFetch(buildUrl(QUEUE_ACTIVATION_PATH, undefined), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDirectory, directory: worktreePath }),
          signal: controller.signal,
        });

        if (response.ok) return;
        if (isTerminalQueueActivationStatus(response.status)) return;
        if (await isRetryableQueueActivationResponse(response)) {
          attempt += 1;
          continue;
        }
        return;
      } catch {
        // Network failures and per-attempt timeouts are retryable within the budget.
        attempt += 1;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  })()
    .catch(() => {
      // Swallow background repair failures — create already returned the worktree.
    })
    .finally(() => {
      pendingQueueActivationRepairs.delete(dedupeKey);
    });
};

export async function createGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  // Create is non-idempotent: do not attach a hard client timeout on this POST.
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  const payloadJson = await response.json().catch(() => null);

  if (response.ok) {
    const created = parseGitWorktreeCreateResult(payloadJson);
    if (created) return created;
    if (payloadJson && typeof payloadJson === 'object') {
      return payloadJson as GitWorktreeCreateResult;
    }
    throw new Error('Failed to create worktree');
  }

  const pendingWorktree = parseMessageQueueActivationPending(response.status, payloadJson, directory);
  if (pendingWorktree) {
    scheduleQueueActivationRepair(directory, pendingWorktree.path);
    return pendingWorktree;
  }

  const error = payloadJson && typeof payloadJson === 'object'
    ? payloadJson as { error?: string }
    : { error: response.statusText };
  throw new Error(error.error || 'Failed to create worktree');
}

export async function deleteGitWorktree(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }

  return response.json();
}

export async function createGitCommit(
  directory: string,
  message: string,
  options: CreateGitCommitOptions = {}
): Promise<GitCommitResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      addAll: options.addAll ?? false,
      files: options.files,
      stageFiles: options.stageFiles,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create commit');
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<GitPushResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/push`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to push');
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitPull(
  directory: string,
  options: GitPullOptions = {}
): Promise<GitPullResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/pull`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to pull');
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/fetch`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to fetch');
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list stashes');
  }
  return response.json();
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes/file-counts`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to count stash files');
  }
  return response.json();
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stash`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to stash changes');
  }
  return response.json();
}

const postStashRef = async (directory: string, path: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> => {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/${path}`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to ${path}`);
  }
  return response.json();
};

export const applyGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/apply', options);
export const popGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/pop', options);
export const dropGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/drop', options);

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to checkout branch');
  }
  return response.json();
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, startPoint }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create branch');
  }
  return response.json();
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches/rename`, directory), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rename branch');
  }
  return response.json();
}

export async function getGitLog(
  directory: string,
  options: GitLogOptions = {}
): Promise<GitLogResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/log`, directory, {
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
      all: options.all ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to get git log: ${errorBody.error || response.statusText}`);
  }
  return response.json();
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<GitCommitFilesResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-files`, directory, { hash })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit files: ${response.statusText}`);
  }
  return response.json();
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<CommitFileDiffResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-file-diff`, directory, {
      hash,
      path: filePath,
      binary: isBinary ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit file diff: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitIdentities(): Promise<GitIdentityProfile[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get git identities: ${response.statusText}`);
  }
  return response.json();
}

export async function createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create git identity');
  }
  return response.json();
}

export async function updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to update git identity');
  }
  return response.json();
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete git identity');
  }
}

export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/current-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get current git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/has-local-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to check local identity: ${response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.hasLocalIdentity === true;
}

export async function getGlobalGitIdentity(): Promise<GitIdentitySummary | null> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/global-identity`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get global git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || (!data.userName && !data.userEmail)) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: GitIdentityProfile }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/set-identity`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to set git identity');
  }
  return response.json();
}

export async function discoverGitCredentials(): Promise<DiscoveredGitCredential[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/discover-credentials`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to discover git credentials: ${response.statusText}`);
  }
  return response.json();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remote-url`, directory, { remote }));
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.url ?? null;
}

export async function getRemotes(directory: string, options?: { signal?: AbortSignal }): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory), { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to get remotes: ${response.statusText}`);
  }
  return response.json();
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rebase');
  }
  return response.json();
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort rebase');
  }
  return response.json();
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to merge');
  }
  return response.json();
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<CheckoutCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to checkout commit');
  }
  return response.json();
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<CherryPickResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/cherry-pick`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to cherry-pick');
  }
  return response.json();
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<RevertCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to revert commit');
  }
  return response.json();
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<ResetToCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/reset-to-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, mode, force }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to reset');
  }
  return response.json();
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort merge');
  }
  return response.json();
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue rebase');
  }
  return response.json();
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue merge');
  }
  return response.json();
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  await stashGitChanges(directory, { message: options?.message });
  return { success: true };
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  await popGitStash(directory, { ref: 'stash@{0}' });
  return { success: true };
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get conflict details: ${response.statusText}`);
  }
  return response.json();
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/validate-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, worktreeRoot }),
  });
  if (!response.ok) {
    throw new Error(`Failed to validate worktree directory: ${response.statusText}`);
  }
  return response.json();
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/canonicalize-worktree-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(`Failed to canonicalize worktree state: ${response.statusText}`);
  }
  return response.json();
}
