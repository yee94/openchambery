
import * as gitHttp from './gitApiHttp';
import { opencodeClient } from './opencode/client';
import { renderMagicPrompt } from './magicPrompts';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { materializeOpenDraftSession, useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

export type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitBranchDetails,
  GitBranch,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitIdentityProfile,
  GitIdentityAuthType,
  GitIdentitySummary,
  GitLogEntry,
  GitLogResponse,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationError,
  GitWorktreeValidationResult,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  DiscoveredGitCredential,
  GitRemote,
  GitMergeResult,
  GitRebaseResult,
  MergeConflictDetails,
  CommitFileDiffResponse,
} from './api/types';

const getRuntimeGit = () => {
  return getRegisteredRuntimeAPIs()?.git ?? null;
};

const extractJsonObject = (value: string): Record<string, unknown> | null => {
  const text = value.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const starts = [candidate.indexOf('{')].filter((index) => index >= 0);

  for (const start of starts) {
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
  }

  return null;
};

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkIsGitRepository(directory);
  return gitHttp.checkIsGitRepository(directory);
}

/** Batch-discover repo + primary root; seeds HTTP discovery caches. */
export async function discoverGitRepositories(
  directories: string[],
): Promise<Map<string, gitHttp.GitDiscoverEntry>> {
  return gitHttp.discoverGitRepositories(directories);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<import('./api/types').GitStatus> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitStatus(directory, options);
  return gitHttp.getGitStatus(directory, options);
}

export async function resolveGitPrimaryRoot(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitPrimaryRoot(directory);
  return result.root;
}

export async function resolveGitTopLevel(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitTopLevel(directory);
  return result.root;
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<Array<{ sha: string; short: string; subject: string }>> {
  const result = await gitHttp.getGitCommitSummaries(directory, shas);
  return result.commits;
}

export async function getGitDiff(directory: string, options: import('./api/types').GetGitDiffOptions): Promise<import('./api/types').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitDiff(directory, options);
  return gitHttp.getGitDiff(directory, options);
}

export async function getGitFileDiff(
  directory: string,
  options: import('./api/types').GetGitFileDiffOptions
): Promise<import('./api/types').GitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitFileDiff(directory, options);
  return gitHttp.getGitFileDiff(directory, options);
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertGitFile(directory, filePath, options);
  return gitHttp.revertGitFile(directory, filePath, options);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFile) return runtime.stageGitFile(directory, filePath);
  return gitHttp.stageGitFile(directory, filePath);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFiles) return runtime.stageGitFiles(directory, filePaths);
  return gitHttp.stageGitFiles(directory, filePaths);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFile) return runtime.unstageGitFile(directory, filePath);
  return gitHttp.unstageGitFile(directory, filePath);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFiles) return runtime.unstageGitFiles(directory, filePaths);
  return gitHttp.unstageGitFiles(directory, filePaths);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitHunk) return runtime.stageGitHunk(directory, filePath, patch);
  return gitHttp.stageGitHunk(directory, filePath, patch);
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitHunk) return runtime.unstageGitHunk(directory, filePath, patch);
  return gitHttp.unstageGitHunk(directory, filePath, patch);
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.revertGitHunk) return runtime.revertGitHunk(directory, filePath, patch);
  return gitHttp.revertGitHunk(directory, filePath, patch);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.isLinkedWorktree(directory);
  return gitHttp.isLinkedWorktree(directory);
}

export async function getGitBranches(directory: string, options?: { signal?: AbortSignal }): Promise<import('./api/types').GitBranch> {
  const runtime = getRuntimeGit();
  options?.signal?.throwIfAborted();
  if (runtime) {
    const result = await runtime.getGitBranches(directory, options);
    options?.signal?.throwIfAborted();
    return result;
  }
  return gitHttp.getGitBranches(directory, options);
}

export async function deleteGitBranch(directory: string, payload: import('./api/types').GitDeleteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitBranch(directory, payload);
  return gitHttp.deleteGitBranch(directory, payload);
}

export async function deleteRemoteBranch(directory: string, payload: import('./api/types').GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteRemoteBranch(directory, payload);
  return gitHttp.deleteRemoteBranch(directory, payload);
}

/** Explicit commit-diff input budget. Truncation is labeled — never claim full coverage. */
export const COMMIT_DIFF_FILE_LIMIT = 30;
export const COMMIT_DIFF_TOTAL_CHAR_LIMIT = 120_000;

/** session.generate one-shot timeout (ms). Caller AbortSignal still cancels earlier. */
export const SESSION_GENERATE_TIMEOUT_MS = 90_000;

const SESSION_GENERATE_ASIDE_PREAMBLE = [
  'This is an auxiliary structured generation request (git copy).',
  'Use the active session context plus the materials below.',
  'Answer with the required JSON only.',
  'Do not call any tools and do not take any actions.',
  'Model and instructions follow the session.generate session contract.',
].join(' ');

const GENERATION_NO_SESSION_ERROR =
  'Select an active session for generation. session.generate uses that session model contract and does not mutate chat history.';
const GENERATION_CONFIG_ERROR =
  'No default provider or model configured. Please select a provider and model in settings first.';
const GENERATION_RUNTIME_CHANGED_ERROR = 'Runtime changed during session.generate';
const GENERATION_EMPTY_ERROR = 'session.generate returned empty text';
const GENERATION_INVALID_JSON_ERROR = 'session.generate returned invalid structured output';

export type GitGenerationOptions = {
  zenModel?: string;
  providerId?: string;
  modelId?: string;
  /** Cancels small-model fetch and session.generate. */
  signal?: AbortSignal;
};

export type CommitDiffBudget = {
  /** Diff text actually included in the prompt (may be partial). */
  text: string;
  selectedFileCount: number;
  includedFileCount: number;
  omittedFileCount: number;
  truncatedByCharLimit: boolean;
  fileLimit: number;
  charLimit: number;
  /** Human-readable budget note — must accompany materials so partial input is explicit. */
  budgetNote: string;
};

const formatCommitDiffBudgetNote = (budget: Omit<CommitDiffBudget, 'text' | 'budgetNote'>): string => {
  const parts = [
    `Diff budget: included ${budget.includedFileCount} of ${budget.selectedFileCount} selected files`,
    `fileLimit=${budget.fileLimit}`,
    `charLimit=${budget.charLimit}`,
    `truncatedByCharLimit=${budget.truncatedByCharLimit ? 'yes' : 'no'}`,
    `omittedFiles=${budget.omittedFileCount}`,
  ];
  const guidance = budget.omittedFileCount > 0 || budget.truncatedByCharLimit
    ? ' Materials are partial under this budget — do not invent diffs for omitted or truncated files; base the message only on provided material.'
    : ' Materials cover the full selected set within the budget.';
  return `${parts.join('; ')}.${guidance}`;
};

/**
 * Collect staged+unstaged diffs for selected paths under an explicit size budget.
 * Omitted/truncated coverage is labeled in `budgetNote` and markers inside `text`.
 */
export async function collectSelectedFileDiffs(
  directory: string,
  files: string[],
): Promise<CommitDiffBudget> {
  const selectedFileCount = files.length;
  const limited = files.slice(0, COMMIT_DIFF_FILE_LIMIT);
  const chunks = await Promise.all(limited.map(async (path) => {
    try {
      const [staged, unstaged] = await Promise.all([
        gitHttp.getGitDiff(directory, { path, staged: true }).catch(() => null),
        gitHttp.getGitDiff(directory, { path, staged: false }).catch(() => null),
      ]);
      const text = [staged?.diff, unstaged?.diff]
        .filter((diff): diff is string => typeof diff === 'string' && diff.trim().length > 0)
        .join('\n');
      return text ? text : `--- ${path} (no textual diff available)`;
    } catch {
      return `--- ${path} (diff unavailable)`;
    }
  }));

  let total = '';
  let includedFileCount = 0;
  let truncatedByCharLimit = false;
  for (const chunk of chunks) {
    const separator = total ? '\n\n' : '';
    if (total.length + separator.length + chunk.length > COMMIT_DIFF_TOTAL_CHAR_LIMIT) {
      total += '\n[remaining diffs truncated by char budget — not a full selected-set dump]';
      truncatedByCharLimit = true;
      break;
    }
    total += separator + chunk;
    includedFileCount += 1;
  }

  const omittedByFileLimit = Math.max(0, selectedFileCount - limited.length);
  const omittedByCharLimit = truncatedByCharLimit
    ? Math.max(0, limited.length - includedFileCount)
    : 0;
  const omittedFileCount = omittedByFileLimit + omittedByCharLimit;
  if (omittedByFileLimit > 0) {
    total += `\n[${omittedByFileLimit} more selected files omitted by file budget — not included]`;
  }

  const meta = {
    selectedFileCount,
    includedFileCount,
    omittedFileCount,
    truncatedByCharLimit,
    fileLimit: COMMIT_DIFF_FILE_LIMIT,
    charLimit: COMMIT_DIFF_TOTAL_CHAR_LIMIT,
  };
  return {
    ...meta,
    text: total,
    budgetNote: formatCommitDiffBudgetNote(meta),
  };
}

const parseCommitStructured = (structured: Record<string, unknown> | null): { subject: string; highlights: string[] } => {
  const subject = typeof structured?.subject === 'string' ? structured.subject.trim() : '';
  const highlights = Array.isArray(structured?.highlights)
    ? structured.highlights.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3)
    : [];
  if (!subject) {
    throw new Error('Structured output missing subject');
  }
  return { subject, highlights };
};

const parsePrStructured = (structured: Record<string, unknown> | null): import('./api/types').GeneratedPullRequestDescription => ({
  title: typeof structured?.title === 'string' ? structured.title.trim() : '',
  body: typeof structured?.body === 'string' ? structured.body.trim() : '',
});

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
  return name === 'AbortError' || name === 'TimeoutError';
};

const createGenerationSignal = (outer?: AbortSignal): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController();
  const onOuterAbort = () => {
    try {
      controller.abort(outer?.reason);
    } catch {
      controller.abort();
    }
  };
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    const reason = new DOMException(
      `session.generate timed out after ${SESSION_GENERATE_TIMEOUT_MS}ms`,
      'TimeoutError',
    );
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  }, SESSION_GENERATE_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
  };
};

/**
 * Resolve the session id for session.generate.
 * Model/agent come from the session contract upstream — client selection is not required
 * when an existing session is open. Draft materialization still needs settings model.
 */
async function resolveGenerationSessionId(): Promise<string> {
  const current = useSessionUIStore.getState().currentSessionId;
  if (typeof current === 'string' && current.trim()) {
    return current.trim();
  }

  const draft = useSessionUIStore.getState().newSessionDraft;
  if (!draft?.open) {
    throw new Error(GENERATION_NO_SESSION_ERROR);
  }

  const config = useConfigStore.getState();
  if (!config.currentProviderId || !config.currentModelId) {
    throw new Error(GENERATION_CONFIG_ERROR);
  }

  const createdDraftSession = await materializeOpenDraftSession({
    providerID: config.currentProviderId,
    modelID: config.currentModelId,
    agent: config.currentAgentName || undefined,
    variant: config.currentVariant || undefined,
  });

  if (createdDraftSession?.sessionId) {
    return createdDraftSession.sessionId;
  }

  const retry = useSessionUIStore.getState().currentSessionId;
  if (typeof retry === 'string' && retry.trim()) {
    return retry.trim();
  }
  throw new Error('Failed to create session for generation');
}

type SessionGenerateCapture = {
  sessionId: string;
  directory: string;
  kind: 'commit' | 'pr';
  runtimeGeneration: number;
  runtimeTransport: string;
};

/**
 * One-shot session.generate fallback. Does not steer, wait for idle, or read
 * the last assistant message — main session history/inbox/execution stay stable.
 * Late results after runtime switch are rejected against the capture snapshot.
 */
async function runSessionGenerateStructured(params: {
  directory: string;
  prompt: string;
  kind: 'commit' | 'pr';
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const sessionId = await resolveGenerationSessionId();
  const capture: SessionGenerateCapture = {
    sessionId,
    directory: params.directory,
    kind: params.kind,
    runtimeGeneration: getRuntimeGeneration(),
    runtimeTransport: getRuntimeTransportIdentity(),
  };

  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt) {
    throw new Error('Generation prompts are empty');
  }

  const { signal, cleanup } = createGenerationSignal(params.signal);
  const requestStartedAt = Date.now();
  console.info('[git-generation][browser] session.generate start', {
    kind: capture.kind,
    directory: capture.directory,
    sessionId: capture.sessionId,
    promptChars: prompt.length,
    transport: 'session.generate',
    modelSource: 'session-contract',
  });

  try {
    signal.throwIfAborted();
    const result = await opencodeClient.generateSessionAside({
      sessionId: capture.sessionId,
      directory: capture.directory,
      prompt,
      signal,
    });

    if (
      getRuntimeGeneration() !== capture.runtimeGeneration
      || getRuntimeTransportIdentity() !== capture.runtimeTransport
    ) {
      throw new Error(GENERATION_RUNTIME_CHANGED_ERROR);
    }

    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) {
      throw new Error(GENERATION_EMPTY_ERROR);
    }

    const parsed = extractJsonObject(text);
    if (!parsed) {
      console.error('[git-generation][browser] invalid JSON from session.generate', {
        kind: capture.kind,
        sessionId: capture.sessionId,
        elapsedMs: Date.now() - requestStartedAt,
        textPreview: text.slice(0, 400),
      });
      throw new Error(GENERATION_INVALID_JSON_ERROR);
    }

    console.info('[git-generation][browser] session.generate success', {
      kind: capture.kind,
      sessionId: capture.sessionId,
      elapsedMs: Date.now() - requestStartedAt,
      responseChars: text.length,
    });
    return parsed;
  } catch (error) {
    if (isAbortLikeError(error, signal)) {
      const message = signal.reason instanceof Error
        ? signal.reason.message
        : typeof signal.reason === 'string' && signal.reason.trim()
          ? signal.reason
          : `session.generate cancelled`;
      const abortError = new DOMException(message, signal.reason instanceof DOMException ? signal.reason.name : 'AbortError');
      throw abortError;
    }
    throw error;
  } finally {
    cleanup();
  }
}

const buildSessionGeneratePrompt = (visiblePrompt: string, body: string): string => {
  const visible = typeof visiblePrompt === 'string' ? visiblePrompt.trim() : '';
  const material = typeof body === 'string' ? body.trim() : '';
  return [SESSION_GENERATE_ASIDE_PREAMBLE, visible, material].filter(Boolean).join('\n\n');
};

export async function generateCommitMessage(
  directory: string,
  files: string[],
  options?: GitGenerationOptions,
): Promise<{ message: import('./api/types').GeneratedCommitMessage }> {
  const startedAt = Date.now();
  const signal = options?.signal;
  void options?.zenModel;
  void options?.providerId;
  void options?.modelId;

  console.info('[git-generation][browser] request', {
    transport: 'small-model',
    kind: 'commit',
    directory,
    selectedFiles: files.length,
  });

  const visiblePrompt = await renderMagicPrompt('git.commit.generate.visible');
  const hiddenPrompt = await renderMagicPrompt('git.commit.generate.instructions', {
    selected_files: files.map((file) => `- ${file}`).join('\n'),
  });

  try {
    signal?.throwIfAborted();
    const diffs = await collectSelectedFileDiffs(directory, files);
    const materialPrompt = [
      hiddenPrompt,
      diffs.budgetNote,
      'Diffs of the selected files (budget-aligned; see note above):',
      diffs.text,
    ].join('\n\n');

    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const response = await runtimeFetch('/api/small-model/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purpose: 'commit',
        system: visiblePrompt,
        prompt: materialPrompt,
        directory,
        ...(currentProviderId ? { preferredProviderID: currentProviderId } : {}),
        ...(currentModelId ? { preferredModelID: currentModelId } : {}),
      }),
      ...(signal ? { signal } : {}),
    });

    if (response.status === 404) {
      // No authenticated provider has a small model — fall back to session.generate
      // so free-model-only setups keep a working button without steering the main turn.
      console.info('[git-generation][browser] small model unavailable, falling back to session.generate', {
        kind: 'commit',
        selectedFiles: files.length,
        includedFiles: diffs.includedFileCount,
        omittedFiles: diffs.omittedFileCount,
        truncatedByCharLimit: diffs.truncatedByCharLimit,
        promptChars: materialPrompt.length,
      });
      const structured = await runSessionGenerateStructured({
        directory,
        prompt: buildSessionGeneratePrompt(visiblePrompt, materialPrompt),
        kind: 'commit',
        signal,
      });
      const result = { message: parseCommitStructured(structured) };
      console.info('[git-generation][browser] success', {
        transport: 'session.generate',
        kind: 'commit',
        elapsedMs: Date.now() - startedAt,
        subjectLength: result.message.subject.length,
        highlightsCount: result.message.highlights.length,
        diffBudget: {
          includedFileCount: diffs.includedFileCount,
          omittedFileCount: diffs.omittedFileCount,
          truncatedByCharLimit: diffs.truncatedByCharLimit,
        },
      });
      return result;
    }

    const payload = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (!response.ok || typeof payload?.text !== 'string') {
      const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const result = { message: parseCommitStructured(extractJsonObject(payload.text)) };
    console.info('[git-generation][browser] success', {
      transport: 'small-model',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      subjectLength: result.message.subject.length,
      highlightsCount: result.message.highlights.length,
      diffBudget: {
        includedFileCount: diffs.includedFileCount,
        omittedFileCount: diffs.omittedFileCount,
        truncatedByCharLimit: diffs.truncatedByCharLimit,
      },
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'small-model|session.generate',
      kind: 'commit',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

export async function generatePullRequestDescription(
  directory: string,
  payload: {
    base: string;
    head: string;
    context?: string;
    zenModel?: string;
    providerId?: string;
    modelId?: string;
    signal?: AbortSignal;
  },
): Promise<import('./api/types').GeneratedPullRequestDescription> {
  const startedAt = Date.now();
  const signal = payload.signal;

  const commitLog = await getGitLog(directory, {
    from: payload.base,
    to: payload.head,
    maxCount: 50,
  });
  const COMMIT_BODY_CHAR_LIMIT = 2_000;
  const commits = (Array.isArray(commitLog?.all) ? commitLog.all : [])
    .filter((entry) => typeof entry?.hash === 'string' && entry.hash.length > 0)
    .map((entry) => ({
      hash: entry.hash,
      subject: typeof entry.message === 'string' ? entry.message.trim() : '',
      body: typeof entry.body === 'string' ? entry.body.trim().slice(0, COMMIT_BODY_CHAR_LIMIT) : '',
    }));

  if (commits.length === 0) {
    throw new Error(`No commits found in range ${payload.base}...${payload.head}`);
  }

  const filesSet = new Set<string>();
  await Promise.all(commits.map(async (commit) => {
    try {
      const response = await getCommitFiles(directory, commit.hash);
      const files = Array.isArray(response?.files) ? response.files : [];
      for (const file of files) {
        if (typeof file?.path === 'string' && file.path.trim().length > 0) {
          filesSet.add(file.path.trim());
        }
      }
    } catch (error) {
      console.warn('[git-generation][browser] failed to collect commit files', {
        hash: commit.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  const changedFiles = Array.from(filesSet).sort().slice(0, 300);

  console.info('[git-generation][browser] request', {
    transport: 'small-model',
    kind: 'pr',
    directory,
    base: payload.base,
    head: payload.head,
    commits: commits.length,
    changedFiles: changedFiles.length,
  });

  const visiblePrompt = await renderMagicPrompt('git.pr.generate.visible');
  const hiddenPrompt = await renderMagicPrompt('git.pr.generate.instructions', {
    base_branch: payload.base,
    head_branch: payload.head,
    commits: commits.map((commit) => {
      const line = `- ${commit.hash.slice(0, 7)} ${commit.subject || '(no subject)'}`;
      if (!commit.body) return line;
      const indentedBody = commit.body.split('\n').map((bodyLine) => `  ${bodyLine}`).join('\n');
      return `${line}\n${indentedBody}`;
    }).join('\n'),
    changed_files: changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '- none detected',
    additional_context_block: payload.context?.trim() ? `\nAdditional context:\n${payload.context.trim()}` : '',
  });

  try {
    signal?.throwIfAborted();
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const response = await runtimeFetch('/api/small-model/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: visiblePrompt,
        prompt: hiddenPrompt,
        directory,
        ...(currentProviderId ? { preferredProviderID: currentProviderId } : {}),
        ...(currentModelId ? { preferredModelID: currentModelId } : {}),
      }),
      ...(signal ? { signal } : {}),
    });

    if (response.status === 404) {
      console.info('[git-generation][browser] small model unavailable, falling back to session.generate', {
        kind: 'pr',
        commits: commits.length,
        changedFiles: changedFiles.length,
        hasAdditionalContext: Boolean(payload.context?.trim()),
      });
      const structured = await runSessionGenerateStructured({
        directory,
        prompt: buildSessionGeneratePrompt(visiblePrompt, hiddenPrompt),
        kind: 'pr',
        signal,
      });
      const result = parsePrStructured(structured);
      console.info('[git-generation][browser] success', {
        transport: 'session.generate',
        kind: 'pr',
        elapsedMs: Date.now() - startedAt,
        titleLength: result.title.length,
        bodyLength: result.body.length,
      });
      return result;
    }

    const responsePayload = await response.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (!response.ok || typeof responsePayload?.text !== 'string') {
      const message = typeof responsePayload?.error === 'string' ? responsePayload.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const result = parsePrStructured(extractJsonObject(responsePayload.text));
    console.info('[git-generation][browser] success', {
      transport: 'small-model',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      titleLength: result.title.length,
      bodyLength: result.body.length,
    });
    return result;
  } catch (error) {
    console.error('[git-generation][browser] failed', {
      transport: 'small-model|session.generate',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

export async function listGitWorktrees(directory: string): Promise<import('./api/types').GitWorktreeInfo[]> {
  const runtime = getRuntimeGit();
  if (!runtime) return gitHttp.listGitWorktrees(directory);

  // Runtime bridges bypass gitApiHttp's discovery gate — wrap them the same way.
  // The web/mobile bridge is the exception: it points straight back at
  // gitApiHttp, which takes its own slot. Wrapping that again makes one listing
  // hold two of the gate's two permits, so two overlapping catalog refreshes
  // deadlock the gate and every later discovery call stalls forever.
  const bridged = runtime.worktree?.list ?? runtime.listGitWorktrees;
  if (gitHttp.isGitDiscoveryGated(bridged)) {
    return gitHttp.listGitWorktrees(directory);
  }

  const invoke = runtime.worktree?.list
    ? runtime.worktree.list.bind(runtime.worktree)
    : runtime.listGitWorktrees.bind(runtime);
  return gitHttp.withGitDiscoveryNetworkSlot(() => invoke(directory));
}

export async function validateGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeValidationResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.validate) {
    return runtime.worktree.validate(directory, payload);
  }
  if (runtime?.validateGitWorktree) {
    return runtime.validateGitWorktree(directory, payload);
  }
  return gitHttp.validateGitWorktree(directory, payload);
}

export async function getGitWorktreeBootstrapStatus(
  directory: string,
): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.bootstrapStatus) {
    return runtime.worktree.bootstrapStatus(directory);
  }
  if (runtime?.getGitWorktreeBootstrapStatus) {
    return runtime.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
}

export async function previewGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.preview) {
    return runtime.worktree.preview(directory, payload);
  }
  if (runtime?.previewGitWorktree) {
    return runtime.previewGitWorktree(directory, payload);
  }
  return gitHttp.previewGitWorktree(directory, payload);
}

export async function createGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  let created: import('./api/types').GitWorktreeCreateResult;
  if (runtime?.worktree?.create) {
    created = await runtime.worktree.create(directory, payload);
  } else if (runtime?.createGitWorktree) {
    created = await runtime.createGitWorktree(directory, payload);
  } else {
    created = await gitHttp.createGitWorktree(directory, payload);
  }
  // Runtime bridges may bypass gitApiHttp; always drop the shared HTTP list cache
  // so a concurrent forceRefresh cannot reseat a pre-create listing.
  gitHttp.invalidateGitWorktreesCache(directory);
  return created;
}

export async function deleteGitWorktree(
  directory: string,
  payload: import('./api/types').RemoveGitWorktreePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  let removed: { success: boolean };
  if (runtime?.worktree?.remove) {
    removed = await runtime.worktree.remove(directory, payload);
  } else if (runtime?.deleteGitWorktree) {
    removed = await runtime.deleteGitWorktree(directory, payload);
  } else {
    removed = await gitHttp.deleteGitWorktree(directory, payload);
  }
  // Same as create: keep HTTP discovery cache coherent even when remove ran on
  // a native/runtime bridge that never touched gitApiHttp.
  gitHttp.invalidateGitWorktreesCache(directory);
  return removed;
}

export const git = {
  worktree: {
    list: listGitWorktrees,
    validate: validateGitWorktree,
    create: createGitWorktree,
    remove: deleteGitWorktree,
  },
};

export async function createGitCommit(
  directory: string,
  message: string,
  options: import('./api/types').CreateGitCommitOptions = {}
): Promise<import('./api/types').GitCommitResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitCommit(directory, message, options);
  return gitHttp.createGitCommit(directory, message, options);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<import('./api/types').GitPushResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPush(directory, options);
  return gitHttp.gitPush(directory, options);
}

export async function gitPull(
  directory: string,
  options: import('./api/types').GitPullOptions = {}
): Promise<import('./api/types').GitPullResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPull(directory, options);
  return gitHttp.gitPull(directory, options);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitFetch(directory, options);
  return gitHttp.gitFetch(directory, options);
}

export async function listGitStashes(directory: string): Promise<{ stashes: import('./api/types').GitStashEntry[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.listGitStashes(directory);
  return gitHttp.listGitStashes(directory);
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.countGitStashFiles(directory, refs);
  return gitHttp.countGitStashFiles(directory, refs);
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashGitChanges(directory, options);
  return gitHttp.stashGitChanges(directory, options);
}

export async function applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.applyGitStash(directory, options);
  return gitHttp.applyGitStash(directory, options);
}

export async function popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.popGitStash(directory, options);
  return gitHttp.popGitStash(directory, options);
}

export async function dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.dropGitStash(directory, options);
  return gitHttp.dropGitStash(directory, options);
}

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutBranch(directory, branch);
  return gitHttp.checkoutBranch(directory, branch);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createBranch(directory, name, startPoint);
  return gitHttp.createBranch(directory, name, startPoint);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.renameBranch(directory, oldName, newName);
  return gitHttp.renameBranch(directory, oldName, newName);
}

export async function getGitLog(
  directory: string,
  options: import('./api/types').GitLogOptions = {}
): Promise<import('./api/types').GitLogResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitLog(directory, options);
  return gitHttp.getGitLog(directory, options);
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<import('./api/types').GitCommitFilesResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCommitFiles(directory, hash);
  return gitHttp.getCommitFiles(directory, hash);
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<import('./api/types').CommitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime?.getCommitFileDiff) return runtime.getCommitFileDiff(directory, hash, filePath, isBinary);
  return gitHttp.getCommitFileDiff(directory, hash, filePath, isBinary);
}

export async function getGitIdentities(): Promise<import('./api/types').GitIdentityProfile[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitIdentities();
  return gitHttp.getGitIdentities();
}

export async function createGitIdentity(profile: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitIdentity(profile);
  return gitHttp.createGitIdentity(profile);
}

export async function updateGitIdentity(id: string, updates: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.updateGitIdentity(id, updates);
  return gitHttp.updateGitIdentity(id, updates);
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitIdentity(id);
  return gitHttp.deleteGitIdentity(id);
}

export async function getCurrentGitIdentity(directory: string): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCurrentGitIdentity(directory);
  return gitHttp.getCurrentGitIdentity(directory);
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime?.hasLocalIdentity) return runtime.hasLocalIdentity(directory);
  return gitHttp.hasLocalIdentity(directory);
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: import('./api/types').GitIdentityProfile }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.setGitIdentity(directory, profileId);
  return gitHttp.setGitIdentity(directory, profileId);
}

export async function discoverGitCredentials(): Promise<import('./api/types').DiscoveredGitCredential[]> {
  const runtime = getRuntimeGit();
  if (runtime?.discoverGitCredentials) return runtime.discoverGitCredentials();
  return gitHttp.discoverGitCredentials();
}

export async function getGlobalGitIdentity(): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getGlobalGitIdentity) return runtime.getGlobalGitIdentity();
  return gitHttp.getGlobalGitIdentity();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getRemoteUrl) return runtime.getRemoteUrl(directory, remote);
  return gitHttp.getRemoteUrl(directory, remote);
}

export async function getRemotes(directory: string, options?: { signal?: AbortSignal }): Promise<import('./api/types').GitRemote[]> {
  const runtime = getRuntimeGit();
  options?.signal?.throwIfAborted();
  if (runtime) {
    const result = await runtime.getRemotes(directory, options);
    options?.signal?.throwIfAborted();
    return result;
  }
  return gitHttp.getRemotes(directory, options);
}

export async function removeRemote(
  directory: string,
  payload: import('./api/types').GitRemoveRemotePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.removeRemote(directory, payload);
  return gitHttp.removeRemote(directory, payload);
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<import('./api/types').GitRebaseResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.rebase(directory, options);
  return gitHttp.rebase(directory, options);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortRebase(directory);
  return gitHttp.abortRebase(directory);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<import('./api/types').GitMergeResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.merge(directory, options);
  return gitHttp.merge(directory, options);
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<import('./api/types').CheckoutCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutCommit(directory, hash);
  return gitHttp.checkoutCommit(directory, hash);
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<import('./api/types').CherryPickResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.cherryPick(directory, hash);
  return gitHttp.cherryPick(directory, hash);
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<import('./api/types').RevertCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertCommit(directory, hash);
  return gitHttp.revertCommit(directory, hash);
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<import('./api/types').ResetToCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.resetToCommit(directory, hash, mode, force);
  return gitHttp.resetToCommit(directory, hash, mode, force);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortMerge(directory);
  return gitHttp.abortMerge(directory);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueRebase(directory);
  return gitHttp.continueRebase(directory);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueMerge(directory);
  return gitHttp.continueMerge(directory);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stash(directory, options);
  return gitHttp.stash(directory, options);
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashPop(directory);
  return gitHttp.stashPop(directory);
}

export async function getConflictDetails(directory: string): Promise<import('./api/types').MergeConflictDetails> {
  const runtime = getRuntimeGit();
  if (runtime?.getConflictDetails) return runtime.getConflictDetails(directory);
  return gitHttp.getConflictDetails(directory);
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
  const runtime = getRuntimeGit();
  if (runtime?.validateWorktreeDirectory) {
    return runtime.validateWorktreeDirectory(directory, worktreeRoot);
  }
  return gitHttp.validateWorktreeDirectory(directory, worktreeRoot);
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
  const runtime = getRuntimeGit();
  if (runtime?.canonicalizeWorktreeState) {
    return runtime.canonicalizeWorktreeState(directory);
  }
  return gitHttp.canonicalizeWorktreeState(directory);
}
