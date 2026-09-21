/**
 * VS Code Extension Host adapter for question auto-delegate.
 * Reuses the platform-agnostic core from packages/web (IO/timer injected here).
 * Authority lives on the Extension Host so timers continue with webviews closed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  createQuestionAutoDelegateCore,
  QUESTION_AUTO_DELEGATE_DELAY_MS,
  QUESTION_SUBMISSION_CLAIMED_CODE,
  type QuestionAutoDelegateCore,
  type QuestionAutoDelegateMutationResult,
  type QuestionAutoDelegateSnapshot,
} from '../../web/server/lib/question-auto-delegate/core.js';
import type { OpenCodeManager } from './opencode';

const REQUEST_TIMEOUT_MS = 15_000;
/** Poll interval while offline auto-submit waits for an upstream base URL. */
const UPSTREAM_URL_POLL_MS = 200;
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

/** Test seam: redirect settings path to a temp fixture (never touch the user file). */
let settingsPathOverrideForTests: string | null = null;

const getSharedSettingsPath = (): string =>
  settingsPathOverrideForTests ?? OPENCHAMBER_SHARED_SETTINGS_PATH;

const asTrimmedString = (value: unknown): string =>
  (typeof value === 'string' && value.trim() ? value.trim() : '');

type SharedSettingsRead =
  | { kind: 'ok'; settings: Record<string, unknown> }
  /** File missing — default enabled true / empty projects. */
  | { kind: 'absent' }
  /** Read or JSON parse failure — core must enter unavailable (no auto timers). */
  | { kind: 'error'; reason: string };

/**
 * Read shared settings without importing bridge-settings (avoids cycle with applyEnabled).
 * Only ENOENT is treated as absent default-on; corrupt/unreadable files are errors.
 */
const readSharedSettingsSnapshot = (): SharedSettingsRead => {
  const settingsPath = getSharedSettingsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'error',
      reason: error instanceof Error ? error.message : 'Settings read failed',
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'ok', settings: parsed as Record<string, unknown> };
    }
    return { kind: 'error', reason: 'Settings root must be a JSON object' };
  } catch (error) {
    return {
      kind: 'error',
      reason: error instanceof Error ? error.message : 'Settings JSON parse failed',
    };
  }
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
};

type MessageSink = { postMessage: (message: unknown) => void };

type UpstreamResult = {
  ok: boolean;
  uncertain?: boolean;
  /**
   * Compatible extension: true only when the request body never left this process
   * (no fetch). Core releases claim → paused for manual retry. Bare status:0 after
   * a real send stays uncertain (not notSent).
   */
  notSent?: boolean;
  status: number;
  body: unknown;
};

/** Directories observed from live events / reconcile (subagent dirs stay timed). */
const observedDirectories = new Set<string>();

let managerRef: OpenCodeManager | null = null;
let coreRef: QuestionAutoDelegateCore | null = null;
let stopCore: (() => void) | null = null;
const tipSinks = new Set<MessageSink>();

const jsonResponse = (status: number, body: unknown): ApiProxyResponsePayload => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyText: JSON.stringify(body),
});

const parseJsonSafe = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const rememberDirectory = (directory: string | null | undefined): void => {
  const next = asTrimmedString(directory);
  if (next) observedDirectories.add(next);
};

const collectDirectoryScopes = (): string[] => {
  const scopes = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = asTrimmedString(folder.uri.fsPath);
    if (folderPath) scopes.add(folderPath);
  }
  const working = asTrimmedString(managerRef?.getWorkingDirectory());
  if (working) scopes.add(working);

  const settingsRead = readSharedSettingsSnapshot();
  if (settingsRead.kind === 'ok') {
    const projects = Array.isArray(settingsRead.settings.projects)
      ? settingsRead.settings.projects
      : [];
    for (const project of projects) {
      const projectPath = asTrimmedString(
        project && typeof project === 'object'
          ? (project as { path?: unknown }).path
          : null,
      );
      if (projectPath) scopes.add(projectPath);
    }
    const pinned = Array.isArray(settingsRead.settings.pinnedDirectories)
      ? settingsRead.settings.pinnedDirectories
      : [];
    for (const entry of pinned) {
      const pinnedPath = asTrimmedString(entry);
      if (pinnedPath) scopes.add(pinnedPath);
    }
  }
  // absent / error: skip settings-derived scopes; observed + workspace still apply.

  for (const directory of observedDirectories) {
    scopes.add(directory);
  }
  return Array.from(scopes);
};

const broadcastTip = (tip: { epoch: string; revision: number }): void => {
  const event = {
    type: 'openchamber:question-auto-delegate-changed',
    properties: {
      epoch: tip.epoch,
      revision: tip.revision,
    },
  };
  for (const sink of tipSinks) {
    try {
      sink.postMessage(event);
    } catch {
      // One closed webview must not break tip delivery.
    }
  }
};

/**
 * Wait briefly for OpenCode base URL (same-endpoint reconnect / restart gap).
 * Offline auto-submit must not fire a never-sent POST as uncertain tombstone.
 */
const waitForUpstreamBaseUrl = async (timeoutMs: number): Promise<string | null> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const baseUrl = asTrimmedString(managerRef?.getApiUrl());
    if (baseUrl) return baseUrl;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(UPSTREAM_URL_POLL_MS, remaining));
    });
  }
  return asTrimmedString(managerRef?.getApiUrl()) || null;
};

/**
 * Classify upstream mutation/list results for the shared core.
 * - Never-sent (no base URL after wait): `notSent: true` + `uncertain: false`
 *   so core releases claim → paused (manual retry). Bare status:0 after fetch
 *   stays uncertain (may have reached upstream).
 * - Transport timeout / 5xx after a real attempt: `uncertain: true` (no retry).
 * - Definitive client errors (400/404/409): `uncertain: false`.
 */
const buildUpstream = async (
  requestPath: string,
  options: { directory?: string; method?: string; body?: unknown } = {},
): Promise<UpstreamResult> => {
  let baseUrl = asTrimmedString(managerRef?.getApiUrl());
  if (!baseUrl) {
    // Offline deadline / brief disconnect: wait for the same upstream, then fail
    // as not-sent rather than uncertain tombstone.
    baseUrl = (await waitForUpstreamBaseUrl(REQUEST_TIMEOUT_MS)) ?? '';
  }
  if (!baseUrl) {
    return {
      ok: false,
      uncertain: false,
      notSent: true,
      status: 0,
      body: { error: 'OpenCode API unavailable' },
    };
  }

  const url = new URL(requestPath.replace(/^\//, ''), `${baseUrl.replace(/\/+$/, '')}/`);
  if (options.directory) {
    url.searchParams.set('directory', options.directory);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(managerRef?.getOpenCodeAuthHeaders() ?? {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Fetch was attempted — may have left the process; keep uncertain tombstone.
    return {
      ok: false,
      uncertain: true,
      status: 0,
      body: { error: error instanceof Error ? error.message : 'Upstream request failed' },
    };
  }

  const parsed = await parseJsonSafe(response);
  if (response.ok) {
    return { ok: true, uncertain: false, status: response.status, body: parsed };
  }
  if (response.status === 404 || response.status === 400 || response.status === 409) {
    return { ok: false, uncertain: false, status: response.status, body: parsed };
  }
  if (response.status >= 500 || response.status === 0) {
    return { ok: false, uncertain: true, status: response.status, body: parsed };
  }
  return { ok: false, uncertain: true, status: response.status, body: parsed };
};

const ensureCore = (): QuestionAutoDelegateCore => {
  if (coreRef) return coreRef;

  coreRef = createQuestionAutoDelegateCore({
    delayMs: QUESTION_AUTO_DELEGATE_DELAY_MS,
    io: {
      now: () => Date.now(),
      createTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        return { clear: () => clearTimeout(handle) };
      },
      createEpoch: () =>
        `qad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      onChanged: broadcastTip,
      async readEnabled() {
        const settingsRead = readSharedSettingsSnapshot();
        if (settingsRead.kind === 'absent') {
          // Missing file ⇒ default on (same as absent key).
          return true;
        }
        if (settingsRead.kind === 'error') {
          // Corrupt / unreadable: core unavailable gate — no auto timers
          // (including when the user had previously turned the feature off).
          return null;
        }
        return settingsRead.settings.questionAutoDelegateEnabled !== false;
      },
      async listDirectories() {
        return collectDirectoryScopes();
      },
      async listQuestions(directory) {
        const result = await buildUpstream('/question', { directory });
        if (!result.ok) return null;
        const payload = result.body;
        if (Array.isArray(payload)) return payload;
        if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
          return (payload as { data: unknown[] }).data;
        }
        return null;
      },
      async getSession(sessionID, directory) {
        const result = await buildUpstream(`/session/${encodeURIComponent(sessionID)}`, {
          directory: directory || undefined,
        });
        if (!result.ok) return null;
        const body = result.body;
        const info =
          body && typeof body === 'object' && (body as { data?: unknown }).data
            && typeof (body as { data: unknown }).data === 'object'
            ? (body as { data: Record<string, unknown> }).data
            : body;
        if (!info || typeof info !== 'object') return null;
        const record = info as Record<string, unknown>;
        const resolvedDirectory =
          asTrimmedString(record.directory) || asTrimmedString(directory) || null;
        if (resolvedDirectory) rememberDirectory(resolvedDirectory);
        return {
          id: asTrimmedString(record.id) || sessionID,
          parentID: asTrimmedString(record.parentID) || null,
          directory: resolvedDirectory,
        };
      },
      async postReply(requestID, directory, answers) {
        return buildUpstream(`/question/${encodeURIComponent(requestID)}/reply`, {
          directory,
          method: 'POST',
          body: { answers },
        });
      },
      async postReject(requestID, directory, body) {
        return buildUpstream(`/question/${encodeURIComponent(requestID)}/reject`, {
          directory,
          method: 'POST',
          body: body && typeof body === 'object' ? body : {},
        });
      },
    },
  });

  return coreRef;
};

export const addQuestionAutoDelegateTipSink = (sink: MessageSink): (() => void) => {
  tipSinks.add(sink);
  return () => {
    tipSinks.delete(sink);
  };
};

export const getQuestionAutoDelegateCore = (): QuestionAutoDelegateCore | null => coreRef;

export const startQuestionAutoDelegateRuntime = (manager: OpenCodeManager): void => {
  managerRef = manager;
  const core = ensureCore();
  if (!stopCore) {
    stopCore = core.start();
  }
};

export const stopQuestionAutoDelegateRuntime = (): void => {
  try {
    stopCore?.();
  } catch {
    // ignore
  }
  stopCore = null;
  try {
    coreRef?.dispose();
  } catch {
    // ignore
  }
  coreRef = null;
  managerRef = null;
  observedDirectories.clear();
};

export const applyQuestionAutoDelegateEnabled = (enabled: boolean): QuestionAutoDelegateSnapshot | null => {
  if (!coreRef) return null;
  return coreRef.applyEnabled(enabled);
};

export const processQuestionAutoDelegateEvent = (
  payload: unknown,
  directoryHint?: string | null,
): void => {
  if (!coreRef) return;
  const hint = asTrimmedString(directoryHint);
  if (hint) rememberDirectory(hint);
  if (payload && typeof payload === 'object') {
    const properties = (payload as { properties?: unknown }).properties;
    if (properties && typeof properties === 'object') {
      rememberDirectory((properties as { directory?: unknown }).directory as string | undefined);
    }
    rememberDirectory((payload as { directory?: unknown }).directory as string | undefined);
  }
  coreRef.processEvent(payload, hint || undefined);
};

export const reconcileQuestionAutoDelegate = async (
  directories?: string[],
): Promise<QuestionAutoDelegateSnapshot | null> => {
  if (!coreRef) return null;
  if (Array.isArray(directories)) {
    for (const directory of directories) rememberDirectory(directory);
  }
  return coreRef.reconcile(
    directories && directories.length > 0
      ? { directories }
      : { directories: collectDirectoryScopes() },
  );
};

export const noteQuestionAutoDelegateDirectory = (directory: string | null | undefined): void => {
  rememberDirectory(directory);
};

const mutationHttp = (result: QuestionAutoDelegateMutationResult): ApiProxyResponsePayload => {
  if (result.outcome === 'claimed') {
    return jsonResponse(409, {
      error: result.error || 'Question submission already claimed',
      code: result.code || QUESTION_SUBMISSION_CLAIMED_CODE,
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'not_found') {
    return jsonResponse(404, {
      error: result.error || 'Not found',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'error') {
    return jsonResponse(result.status || 500, {
      error: result.error || 'Question auto-delegate error',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'disabled') {
    return jsonResponse(409, {
      error: result.error || 'Question auto-delegate is disabled',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  return jsonResponse(200, {
    outcome: result.outcome,
    snapshot: result.snapshot,
    ...(result.upstreamStatus != null ? { upstreamStatus: result.upstreamStatus } : {}),
  });
};

const submitHttp = (result: QuestionAutoDelegateMutationResult): ApiProxyResponsePayload => {
  if (result.outcome === 'claimed') {
    return jsonResponse(409, {
      error: result.error || 'Question submission already claimed',
      code: result.code || QUESTION_SUBMISSION_CLAIMED_CODE,
    });
  }
  if (result.outcome === 'uncertain') {
    const status =
      result.upstreamStatus && result.upstreamStatus >= 400 ? result.upstreamStatus : 502;
    return jsonResponse(
      status,
      result.upstreamBody ?? { error: result.error || 'Question submission uncertain' },
    );
  }
  if (result.outcome === 'not_found' || result.upstreamStatus === 404) {
    if (result.upstreamBody != null) {
      return jsonResponse(404, result.upstreamBody);
    }
    return jsonResponse(404, { error: 'Question not found' });
  }
  if (result.outcome === 'submitted' || result.outcome === 'settled') {
    const status = result.upstreamStatus && result.upstreamStatus >= 200 ? result.upstreamStatus : 200;
    if (result.upstreamBody === null || result.upstreamBody === undefined) {
      return jsonResponse(status, true);
    }
    return jsonResponse(status, result.upstreamBody);
  }
  if (result.outcome === 'error') {
    return jsonResponse(result.status || 500, { error: result.error || 'Question submission failed' });
  }
  return jsonResponse(
    result.upstreamStatus || 500,
    result.upstreamBody ?? { error: 'Question submission failed' },
  );
};

const readDirectoryFromProxy = (
  requestPath: string,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown> | null,
): string => {
  try {
    const parsed = new URL(requestPath, 'https://openchamber.invalid');
    const fromQuery = asTrimmedString(parsed.searchParams.get('directory'));
    if (fromQuery) return fromQuery;
  } catch {
    // ignore
  }
  const fromBody = asTrimmedString(body?.directory);
  if (fromBody) return fromBody;

  const headerRaw =
    headers?.['x-opencode-directory']
    ?? headers?.['X-Opencode-Directory']
    ?? headers?.['X-OPENCODE-DIRECTORY'];
  if (typeof headerRaw === 'string' && headerRaw.trim()) {
    const encoding =
      headers?.['x-opencode-directory-encoding']
      ?? headers?.['X-Opencode-Directory-Encoding'];
    if (encoding === 'uri') {
      try {
        return decodeURIComponent(headerRaw.trim());
      } catch {
        return headerRaw.trim();
      }
    }
    return headerRaw.trim();
  }
  return '';
};

const parseRequestBody = (bodyBase64: string | undefined): Record<string, unknown> | null => {
  if (typeof bodyBase64 !== 'string' || bodyBase64.length === 0) return null;
  try {
    const text = Buffer.from(bodyBase64, 'base64').toString('utf8');
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const normalizeProxyPathname = (requestPath: string): string => {
  try {
    const parsed = new URL(requestPath, 'https://openchamber.invalid');
    let pathname = parsed.pathname || '/';
    // Webview strips `/api` before proxy; accept both shapes.
    if (pathname.startsWith('/api/')) {
      pathname = pathname.slice(4);
    }
    return pathname.replace(/\/+$/, '') || '/';
  } catch {
    let pathname = requestPath.split('?')[0] || '/';
    if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
    return pathname.replace(/\/+$/, '') || '/';
  }
};

/**
 * Handle OpenChamber-owned question-auto-delegate routes and precise
 * `/question/:id/reply|reject` intercepts inside the existing api:proxy path.
 * Returns null when the path is not owned by this module.
 */
export const tryHandleQuestionAutoDelegateProxy = async (
  method: string,
  requestPath: string,
  headers?: Record<string, string>,
  bodyBase64?: string,
): Promise<ApiProxyResponsePayload | null> => {
  const pathname = normalizeProxyPathname(requestPath);
  const verb = method.toUpperCase();
  const core = coreRef ?? (managerRef ? ensureCore() : null);
  if (!core) {
    // Runtime not started yet — still claim ownership of these routes so they
    // never fall through to OpenCode under a wrong path.
    if (
      pathname === '/question-auto-delegate'
      || pathname.startsWith('/question-auto-delegate/')
      || /^\/question\/[^/]+\/(reply|reject)$/.test(pathname)
    ) {
      return jsonResponse(503, { error: 'Question auto-delegate runtime unavailable' });
    }
    return null;
  }

  if (pathname === '/question-auto-delegate' && verb === 'GET') {
    try {
      return jsonResponse(200, core.snapshot());
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : 'Failed to read question auto-delegate snapshot',
      });
    }
  }

  const pauseMatch = pathname.match(/^\/question-auto-delegate\/requests\/([^/]+)\/pause$/);
  if (pauseMatch && verb === 'POST') {
    const body = parseRequestBody(bodyBase64);
    const reason =
      body?.reason === 'interaction' || body?.reason === 'user'
        ? body.reason
        : (body?.reason as 'interaction' | 'user');
    const result = await core.pause({
      requestID: decodeURIComponent(pauseMatch[1]),
      sessionID: asTrimmedString(body?.sessionID),
      directory: asTrimmedString(body?.directory) || undefined,
      reason,
    });
    return mutationHttp(result);
  }

  const delegateMatch = pathname.match(/^\/question-auto-delegate\/requests\/([^/]+)\/delegate$/);
  if (delegateMatch && verb === 'POST') {
    const body = parseRequestBody(bodyBase64);
    const result = await core.delegate({
      requestID: decodeURIComponent(delegateMatch[1]),
      sessionID: asTrimmedString(body?.sessionID),
      directory: asTrimmedString(body?.directory) || undefined,
    });
    return mutationHttp(result);
  }

  const replyMatch = pathname.match(/^\/question\/([^/]+)\/reply$/);
  if (replyMatch && verb === 'POST') {
    const body = parseRequestBody(bodyBase64);
    const requestID = decodeURIComponent(replyMatch[1]);
    const directory = readDirectoryFromProxy(requestPath, headers, body);
    const answers = Array.isArray(body?.answers) ? body.answers : null;
    if (!answers) {
      return jsonResponse(400, { error: 'answers is required' });
    }
    rememberDirectory(directory);
    const result = await core.submit({
      requestID,
      sessionID: asTrimmedString(body?.sessionID) || undefined,
      directory: directory || undefined,
      kind: 'reply',
      authority: 'manual',
      answers: answers as string[][],
      body,
    });
    return submitHttp(result);
  }

  const rejectMatch = pathname.match(/^\/question\/([^/]+)\/reject$/);
  if (rejectMatch && verb === 'POST') {
    const body = parseRequestBody(bodyBase64);
    const requestID = decodeURIComponent(rejectMatch[1]);
    const directory = readDirectoryFromProxy(requestPath, headers, body);
    rememberDirectory(directory);
    const result = await core.submit({
      requestID,
      sessionID: asTrimmedString(body?.sessionID) || undefined,
      directory: directory || undefined,
      kind: 'reject',
      authority: 'manual',
      body: body && typeof body === 'object' ? body : {},
    });
    return submitHttp(result);
  }

  return null;
};

/** Test seam: inject a pre-built core without OpenCode IO. */
export const __setQuestionAutoDelegateCoreForTests = (
  core: QuestionAutoDelegateCore | null,
): void => {
  coreRef = core;
  if (!core) {
    stopCore = null;
  }
};

export const __resetQuestionAutoDelegateObservedDirectoriesForTests = (): void => {
  observedDirectories.clear();
};

/** Test seam: bind manager used by buildUpstream without starting timers. */
export const __setQuestionAutoDelegateManagerForTests = (manager: OpenCodeManager | null): void => {
  managerRef = manager;
};

/**
 * Test seam: exercise upstream classification (empty URL / wait / fetch).
 * Not part of the production public surface.
 */
export const __buildUpstreamForTests = buildUpstream;

/** Test seam: fan-out tip to registered sinks (same path as core onChanged). */
export const __broadcastQuestionAutoDelegateTipForTests = (tip: {
  epoch: string;
  revision: number;
}): void => {
  broadcastTip(tip);
};

/**
 * Test seam: point settings reads at a temp fixture path.
 * Pass `null` to restore the real user path (never write the real file in tests).
 */
export const __setQuestionAutoDelegateSettingsPathForTests = (settingsPath: string | null): void => {
  settingsPathOverrideForTests = settingsPath;
};

/** Test seam: exercise settings → readEnabled classification without starting OpenCode. */
export const __readQuestionAutoDelegateEnabledForTests = async (): Promise<boolean | null> => {
  const settingsRead = readSharedSettingsSnapshot();
  if (settingsRead.kind === 'absent') return true;
  if (settingsRead.kind === 'error') return null;
  return settingsRead.settings.questionAutoDelegateEnabled !== false;
};
