import { ClientError, isPermissionNotFoundError, OpenCode } from "@opencode-ai/client";
import type { FilesAPI } from "../api/types";
import { getDesktopHomeDirectory } from "../desktop";
import { readInstanceScopedItem } from "../instanceScopedStorage";
import type {
  Agent,
  Config,
  FilePartInput,
  Message,
  OpenCodeClient,
  Part,
  PermissionV2Effect,
  PermissionV2Request,
  PermissionV2Source,
  ProjectedSessionMessage,
  Provider,
  Session,
  SnapshotFileDiff,
  TextPartInput,
} from "./v2-types";
import { mergeConfigDocuments, projectSession } from "./v2-types";
import type { PermissionRequest } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import { convertHeicToJpegViaNative } from "../native-image-transcode";
import { expandImageAttachmentCitations } from "@/components/chat/attachmentCitations";
import { blobFromDataUrl, needsPromptAttachmentUpload, pathFromPromptAttachmentFileUrl, uploadPromptAttachmentBytes } from "../prompt-attachment-upload";

/**
 * Tagged result of `OpencodeService.fetchPermission()`. The caller can
 * distinguish a server-confirmed "no longer pending" permission (HTTP
 * 404) from a fetch failure (network error, malformed response, or a
 * pre-v1.17.12 server without the V2 endpoint).
 */
export type FetchPermissionResult =
  | { state: "ok"; permission: PermissionV2Request }
  | { state: "resolved" }
  | { state: "unknown" };

/**
 * Tagged result of `OpencodeService.getSessionActive()` for OpenCode 1.18+
 * `v2.session.active`. Membership is process-global; sessions absent from a
 * successful map are authoritatively inactive for this OpenCode process.
 *
 * - `supported`: HTTP 200 with a validated membership map
 * - `unsupported`: HTTP 404 / 405 / 501 (endpoint not present)
 * - `unknown`: 401, 5xx, network failure, or malformed body — do not treat as empty success
 */
export type SessionActiveMembership = Record<string, { type: "running" }>;

export type SessionActiveResult =
  | { state: "supported"; membership: SessionActiveMembership }
  | { state: "unsupported" }
  | { state: "unknown" };
import { getRuntimeUrlResolver } from "@/lib/runtime-url";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { getRuntimeKey } from "@/lib/runtime-switch";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { markStartupTrace } from "@/lib/startupTrace";
import { ascendingId } from "@/sync/message-id";
import { postSessionPrompt, postSessionInterrupt } from "@/sync/session-prompt-api";
import { fetchSessionProjectionPage } from "@/sync/session-projection-api";
import { postSessionCompact } from "@/sync/session-compaction-api";
import { postSessionRevertClear, postSessionRevertStage } from "@/sync/session-revert-api";
import { postSessionPermissionReply } from "@/sync/session-permission-api";
import {
  assertProviderCircuitClosed,
  recordProviderSuccess,
  recordProviderError,
} from "./provider-tracker";

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api";
const CONFIG_CACHE_TTL_MS = 10_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 4_000;
const OPENCODE_HEALTH_CACHE_TTL_MS = 3_000;
const OPENCODE_HEALTH_FAILURE_CACHE_TTL_MS = 1_000;
const LIST_AGENTS_TIMEOUT_MS = 12_000;

/**
 * Render an SDK error payload into a short string for Error messages.
 * The SDK returns `{data, error}` shape without throwing on non-2xx; methods
 * that need to signal failure (so callers can preserve state instead of
 * conflating failure with an empty success) wrap the error with this helper.
 */
function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Fail closed when v2 has no client method and no Host shallow-proxy module.
 * Callers must treat this as an observable error, not an empty success.
 */
function v2CapabilityUnavailable(capability: string): Error {
  const error = new Error(`${capability} is not available on OpenCode v2`);
  error.name = "V2CapabilityUnavailableError";
  return error;
}

function clientErrorStatus(error: unknown): number | undefined {
  if (error instanceof ClientError && error.reason === "UnexpectedStatus") {
    const cause = error.cause;
    if (cause && typeof cause === "object" && "status" in cause) {
      const status = (cause as { status?: unknown }).status;
      if (typeof status === "number") return status;
    }
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function isUnsupportedStatus(status: number | undefined): boolean {
  return status === 404 || status === 405 || status === 501;
}

function locationOf(directory?: string | null): { location: { directory: string } } | undefined {
  if (typeof directory !== "string") return undefined;
  const trimmed = directory.trim();
  if (!trimmed) return undefined;
  return { location: { directory: trimmed } };
}

function resolveV2ClientBaseUrl(hostApiBase: string): string {
  const trimmed = hostApiBase.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) {
    const origin = trimmed.slice(0, -4);
    if (origin.length > 0) return origin;
  }
  const runtimeV2 = resolveRuntimeV2BaseUrl();
  if (runtimeV2) return ensureAbsoluteBaseUrl(runtimeV2);
  return ensureAbsoluteBaseUrl("/");
}

function toLocalPermission(item: PermissionV2Request): PermissionRequest | null {
  if (!item || typeof item.id !== "string" || item.id.length === 0) return null;
  if (typeof item.sessionID !== "string" || item.sessionID.length === 0) return null;
  return {
    id: item.id,
    sessionID: item.sessionID,
    permission: item.action,
    patterns: Array.isArray(item.resources) ? item.resources : [],
    metadata: (item.metadata as Record<string, unknown> | undefined) ?? {},
    always: Array.isArray(item.save) ? item.save : [],
    ...(item.source
      ? { tool: { messageID: item.source.messageID, callID: item.source.id } }
      : {}),
  };
}

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

const ensureAbsoluteBaseUrl = (candidate: string): string => {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api";

  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized;
  }

  if (typeof window === "undefined") {
    return normalized;
  }

  const baseReference = window.location?.href || window.location?.origin;
  if (!baseReference) {
    return normalized;
  }

  try {
    return new URL(normalized, baseReference).toString();
  } catch (error) {
    console.warn("Failed to normalize OpenCode base URL:", error);
    return normalized;
  }
};

const resolveRuntimeBaseUrl = (): string | null => {
  try {
    return getRuntimeUrlResolver().api('/api');
  } catch {
    return null;
  }
};

/** V2 SDK endpoints include their own `/api` prefix. */
const resolveRuntimeV2BaseUrl = (): string | null => {
  try {
    return getRuntimeUrlResolver().api('/');
  } catch {
    return null;
  }
};

type AbortSignalConstructorWithTimeout = typeof AbortSignal & {
  timeout?: (milliseconds: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

const createTimeoutSignal = (timeoutMs: number): { signal: AbortSignal; cleanup: () => void } => {
  const abortSignal = typeof AbortSignal !== 'undefined'
    ? AbortSignal as AbortSignalConstructorWithTimeout
    : undefined;
  if (typeof abortSignal?.timeout === 'function') {
    return { signal: abortSignal.timeout(timeoutMs), cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
};

const mergeAbortSignals = (signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } => {
  const live = signals.filter((signal) => signal != null);
  if (live.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => undefined };
  }
  if (live.length === 1) {
    return { signal: live[0], cleanup: () => undefined };
  }
  const abortSignal = typeof AbortSignal !== 'undefined'
    ? AbortSignal as AbortSignalConstructorWithTimeout
    : undefined;
  if (typeof abortSignal?.any === 'function') {
    return { signal: abortSignal.any(live), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', onAbort);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of live) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
};

const createRuntimeOpencodeClient = (config: { baseUrl: string; headers?: HeadersInit }): OpenCodeClient => {
  return OpenCode.make({
    baseUrl: config.baseUrl,
    ...(config.headers ? { headers: config.headers } : {}),
    fetch: runtimeFetch,
  });
};

interface App {
  version?: string;
  [key: string]: unknown;
}

type FilesystemEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
};

export type ProjectFileSearchHit = {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
  /** True when the hit came from a directory-only search. */
  isDirectory?: boolean;
};

type AgentPartInputLite = {
  type: 'agent';
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

type FileInputLite = {
  id?: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
};

/**
 * Internal parts builder — shared between instance method and tests.
 * File normalization is injected so the instance method uses OpencodeService's
 * toNormalizedFilePartInput while tests can supply a passthrough.
 */
const isImagePromptFile = (file: { mime?: string; filename?: string }): boolean => {
  if (typeof file.mime === 'string' && file.mime.startsWith('image/')) return true;
  return typeof file.filename === 'string' && /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|heic|heif|tiff?)$/i.test(file.filename);
};

const imageCitationPathsFromFiles = (files: readonly FilePartInput[]): Array<{ filename: string; path: string }> => {
  const paths: Array<{ filename: string; path: string }> = [];
  for (const file of files) {
    if (!isImagePromptFile(file)) continue;
    const filename = typeof file.filename === 'string' ? file.filename.trim() : '';
    const url = typeof file.url === 'string' ? file.url : '';
    if (!filename || !url.toLowerCase().startsWith('file://')) continue;
    const path = pathFromPromptAttachmentFileUrl(url).trim();
    if (path) paths.push({ filename, path });
  }
  return paths;
};

const _buildPromptParts = async (params: {
  text: string;
  prefaceText?: string;
  prefaceTextSynthetic?: boolean;
  files?: Array<FileInputLite>;
  additionalParts?: Array<{
    text: string;
    synthetic?: boolean;
    files?: Array<FileInputLite>;
  }>;
  agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>;
}, normalizeFile: (file: FileInputLite) => Promise<FilePartInput>): Promise<Array<TextPartInput | FilePartInput | AgentPartInputLite>> => {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInputLite> = [];
  const normalizedFiles = params.files?.length
    ? await Promise.all(params.files.map((file) => normalizeFile(file)))
    : [];
  const additionalNormalized = params.additionalParts?.length
    ? await Promise.all(params.additionalParts.map(async (additional) => ({
      text: additional.text,
      synthetic: additional.synthetic,
      files: additional.files?.length
        ? await Promise.all(additional.files.map((file) => normalizeFile(file)))
        : [],
    })))
    : [];
  const expandText = (text: string): string => expandImageAttachmentCitations(
    text,
    imageCitationPathsFromFiles([
      ...normalizedFiles,
      ...additionalNormalized.flatMap((additional) => additional.files),
    ]),
  );

  if (params.prefaceText && params.prefaceText.trim()) {
    parts.push({
      type: 'text',
      text: expandText(params.prefaceText),
      synthetic: params.prefaceTextSynthetic !== false,
    });
  }

  if (params.text && params.text.trim()) {
    parts.push({
      type: 'text',
      text: expandText(params.text),
    });
  }

  parts.push(...normalizedFiles);

  if (additionalNormalized.length > 0) {
    for (const additional of additionalNormalized) {
      if (additional.text && additional.text.trim()) {
        const tp: TextPartInput = { type: 'text', text: expandText(additional.text) };
        if (additional.synthetic) (tp as Record<string, unknown>).synthetic = true;
        parts.push(tp);
      }
      parts.push(...additional.files);
    }
  }

  if (params.agentMentions && params.agentMentions.length > 0) {
    for (const mention of params.agentMentions) {
      if (!mention?.name) continue;
      const ap: AgentPartInputLite = { type: 'agent', name: mention.name };
      if (mention.source) ap.source = mention.source;
      parts.push(ap);
    }
  }

  if (parts.length === 0) {
    throw new Error('Message must have at least one part (text or file)');
  }

  return parts;
};

type DirectorySwitchResult = {
  success: boolean;
  restarted: boolean;
  path: string;
  agents?: Agent[];
  providers?: Provider[];
  models?: unknown[];
};

const normalizeFsPath = (path: string): string => path.replace(/\\/g, "/");
const FS_LIST_CACHE_TTL_MS = 400;

const getDesktopFilesApi = (): FilesAPI | null => {
  const apis = getRegisteredRuntimeAPIs();
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files;
  }
  return null;
};

class OpencodeService {
  private client: OpenCodeClient;
  private baseUrl: string;
  private scopedClients: Map<string, OpenCodeClient> = new Map();
  private currentDirectory: string | undefined = undefined;
  private directoryContextQueue: Promise<void> = Promise.resolve();
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map();
  private configProvidersInFlight: Map<string, Promise<{ providers: Provider[]; default: { [key: string]: string } }>> = new Map();
  private listAgentsInFlight: Map<string, Promise<Agent[]>> = new Map();
  private configInFlight: Map<string, Promise<Config>> = new Map();
  private configCache: Map<string, { config: Config; expiresAt: number }> = new Map();
  private configCacheGeneration = 0;
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map();
  private healthInFlight: Map<string, Promise<boolean>> = new Map();
  private healthCache: Map<string, { healthy: boolean; expiresAt: number }> = new Map();
  private healthCacheGeneration = 0;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const runtimeBase = resolveRuntimeBaseUrl();
    const requestedBaseUrl = runtimeBase || baseUrl;
    this.baseUrl = ensureAbsoluteBaseUrl(requestedBaseUrl);
    this.client = createRuntimeOpencodeClient({ baseUrl: resolveV2ClientBaseUrl(this.baseUrl) });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  reconnectToRuntimeBaseUrl(): void {
    const runtimeBase = resolveRuntimeBaseUrl();
    const nextBaseUrl = ensureAbsoluteBaseUrl(runtimeBase || DEFAULT_BASE_URL);
    if (nextBaseUrl === this.baseUrl) {
      return;
    }
    this.baseUrl = nextBaseUrl;
    this.client = createRuntimeOpencodeClient({ baseUrl: resolveV2ClientBaseUrl(this.baseUrl) });
    this.scopedClients.clear();
    this.listDirectoryInFlight.clear();
    this.configProvidersInFlight.clear();
    this.listAgentsInFlight.clear();
    this.clearConfigCache();
    this.listDirectoryCache.clear();
    this.clearHealthCache();
  }

  /** Expose the raw SDK client for direct use (e.g., SyncProvider) */
  getSdkClient(): OpenCodeClient {
    return this.client;
  }

  /** Get a scoped SDK client for a specific directory */
  getScopedSdkClient(directory: string): OpenCodeClient {
    return this.getScopedApiClient(directory);
  }

  /**
   * Returns an SDK client scoped to a project directory.
   * Needed for worktree APIs where backend ignores per-call directory.
   */
  getScopedApiClient(directory: string): OpenCodeClient {
    const normalized = this.normalizeCandidatePath(directory) ?? directory;
    const key = normalized || '';
    const existing = this.scopedClients.get(key);
    if (existing) {
      return existing;
    }
    const scoped = createRuntimeOpencodeClient({ baseUrl: resolveV2ClientBaseUrl(this.baseUrl) });
    this.scopedClients.set(key, scoped);
    return scoped;
  }

  private normalizeCandidatePath(path?: string | null): string | null {
    if (typeof path !== 'string') {
      return null;
    }

    const trimmed = path.trim();
    if (!trimmed) {
      return null;
    }

    // Normalize backslashes and uppercase the Windows drive letter so that
    // d:\MyProject and D:\MyProject resolve to the same canonical form.
    const normalized = trimmed
      .replace(/\\/g, '/')
      .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
    const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;

    return withoutTrailingSlash || null;
  }

  private deriveHomeDirectory(path: string): { homeDirectory: string; username?: string } {
    const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/);
    if (windowsMatch) {
      const drive = windowsMatch[1];
      const remainder = path.slice(drive.length + (path.charAt(drive.length) === '/' ? 1 : 0));
      const segments = remainder.split('/').filter(Boolean);

      if (segments.length >= 2) {
        const homeDirectory = `${drive}/${segments[0]}/${segments[1]}`;
        return { homeDirectory, username: segments[1] };
      }

      if (segments.length === 1) {
        const homeDirectory = `${drive}/${segments[0]}`;
        return { homeDirectory, username: segments[0] };
      }

      return { homeDirectory: drive, username: undefined };
    }

    const absolute = path.startsWith('/');
    const segments = path.split('/').filter(Boolean);

    if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
      const homeDirectory = `${absolute ? '/' : ''}${segments[0]}/${segments[1]}`;
      return { homeDirectory, username: segments[1] };
    }

    if (absolute) {
      if (segments.length === 0) {
        return { homeDirectory: '/', username: undefined };
      }
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    if (segments.length > 0) {
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    return { homeDirectory: '/', username: undefined };
  }

  // Set the current working directory for all API calls
  setDirectory(directory: string | undefined) {
    const normalized = this.normalizeCandidatePath(directory) ?? directory;
    if (this.currentDirectory !== normalized) {
      markStartupTrace('opencodeClient:setDirectory', {
        previous: this.currentDirectory ?? null,
        next: normalized ?? null,
      });
    }
    this.currentDirectory = normalized;
  }

  getDirectory(): string | undefined {
    return this.currentDirectory;
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const runWithContext = async (): Promise<T> => {
      if (directory === undefined || directory === null) {
        return fn();
      }

      const previousDirectory = this.currentDirectory;
      const scopedDirectory = this.normalizeCandidatePath(directory) ?? directory;
      this.currentDirectory = scopedDirectory;
      try {
        return await fn();
      } finally {
        if (this.currentDirectory === scopedDirectory) {
          this.currentDirectory = previousDirectory;
        }
      }
    };

    const queuedRun = this.directoryContextQueue.then(runWithContext, runWithContext);
    this.directoryContextQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    );

    return queuedRun;
  }

  // Get the raw API client for direct access
  getApiClient(): OpenCodeClient {
    return this.client;
  }

  // Get system information including home directory
  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates = new Set<string>();
    const addCandidate = (value?: string | null) => {
      const normalized = this.normalizeCandidatePath(value);
      if (normalized) {
        candidates.add(normalized);
      }
    };

    try {
      const info = await this.client.location.get(locationOf(this.currentDirectory));
      if (info) {
        addCandidate(info.directory);
        addCandidate(info.project?.directory);
        addCandidate(info.project?.canonical);
      }
    } catch (error) {
      console.debug('Failed to load path info:', error);
    }

    if (!candidates.size) {
      try {
        const project = await this.client.project.current(locationOf(this.currentDirectory));
        addCandidate(project.directory);
        addCandidate(project.canonical);
      } catch (error) {
        console.debug('Failed to load project info:', error);
      }
    }

    if (!candidates.size) {
      try {
        const sessions = await this.listSessions();
        sessions.forEach((session) => addCandidate(session.directory));
      } catch (error) {
        console.debug('Failed to inspect sessions for system info:', error);
      }
    }

    addCandidate(this.currentDirectory);

    if (typeof window !== 'undefined') {
      try {
        addCandidate(readInstanceScopedItem('lastDirectory'));
        addCandidate(readInstanceScopedItem('homeDirectory'));
      } catch {
        // Access to storage failed (e.g. privacy mode)
      }
    }

    if (!candidates.size && typeof process !== 'undefined' && typeof process.cwd === 'function') {
      addCandidate(process.cwd());
    }

    if (!candidates.size) {
      return { homeDirectory: '/', username: undefined };
    }

    const [primary] = Array.from(candidates);
    return this.deriveHomeDirectory(primary);
  }

  /**
   * Best-effort probe whether a directory is accessible to OpenCode.
   * This is intentionally NOT the same as local filesystem access in the UI runtime.
   */
  async probeDirectory(directory: string): Promise<boolean> {
    const normalized = this.normalizeCandidatePath(directory);
    if (!normalized) {
      return false;
    }
    try {
      const info = await this.client.location.get({ location: { directory: normalized } });
      const returned = typeof info?.directory === 'string' ? info.directory : null;
      return Boolean(returned && returned.trim().length > 0);
    } catch {
      return false;
    }
  }

  // Session Management
  async listSessions(): Promise<Session[]> {
    const response = await this.client.session.list(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    return Array.isArray(response.data) ? response.data.map(projectSession) : [];
  }

  async createSession(params?: { parentID?: string; title?: string; metadata?: Record<string, unknown> }, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    void params?.metadata;
    if (params?.parentID) {
      const forked = await this.client.session.fork({
        sessionID: params.parentID,
        boundary: { type: "through" },
      });
      if (params.title) {
        await this.client.session.rename({ sessionID: forked.id, title: params.title });
        return projectSession(await this.client.session.get({ sessionID: forked.id }));
      }
      return projectSession(forked);
    }
    const created = await this.client.session.create({
      ...(requestDirectory ? { location: { directory: requestDirectory } } : {}),
      title: params?.title,
    });
    return projectSession(created);
  }

  async getSession(id: string, directory?: string | null): Promise<Session> {
    void directory;
    const info = await this.client.session.get({ sessionID: id });
    return projectSession(info);
  }

  async deleteSession(id: string, directory?: string | null): Promise<boolean> {
    void directory;
    await this.client.session.remove({ sessionID: id });
    return true;
  }

  async deleteSessionMessage(sessionId: string, messageId: string, directory?: string | null): Promise<boolean> {
    void sessionId;
    void messageId;
    void directory;
    throw v2CapabilityUnavailable('session.deleteMessage');
  }

  async updateSession(
    id: string,
    patch: { title?: string; metadata?: Record<string, unknown>; time?: { archived?: number | null } },
    directory?: string | null,
  ): Promise<Session> {
    void directory;
    if (patch.metadata !== undefined || patch.time?.archived !== undefined) {
      throw v2CapabilityUnavailable('session.update.metadata|archive');
    }
    if (patch.title === undefined) {
      throw v2CapabilityUnavailable('session.update');
    }
    await this.client.session.rename({ sessionID: id, title: patch.title });
    return projectSession(await this.client.session.get({ sessionID: id }));
  }

  async getSessionMessages(id: string, limit?: number): Promise<ProjectedSessionMessage[]> {
    const page = await fetchSessionProjectionPage({
      sessionID: id,
      directory: this.currentDirectory ?? "",
      ...(typeof limit === "number" ? { limit } : {}),
    });
    return page.records as unknown as ProjectedSessionMessage[];
  }

  /**
   * Full turn/session file diffs including patch bodies.
   * Uses OpenCode `GET /session/{sessionID}/diff` (optional `messageID` scopes to a user turn).
   * Throws on transport/SDK failure — never returns an empty list as a silent success.
   */
  async getSessionDiff(params: {
    sessionID: string;
    directory?: string | null;
    messageID?: string | null;
  }): Promise<SnapshotFileDiff[]> {
    void params;
    throw v2CapabilityUnavailable('session.diff');
  }

  async getSessionTodos(sessionId: string): Promise<Array<{ id: string; content: string; status: string; priority: string }>> {
    void sessionId;
    throw v2CapabilityUnavailable('session.todo');
  }

  /**
   * Check if MIME type needs normalization to text/plain.
   * Some text MIME types (like text/markdown) aren't supported by AI providers.
   */
  private shouldNormalizeToTextPlain(mime: string): boolean {
    if (!mime) return false;
    
    const lowerMime = mime.toLowerCase();
    
    // All text/* types except text/plain need normalization
    if (lowerMime.startsWith('text/') && lowerMime !== 'text/plain') {
      return true;
    }
    
    // Common application types that are actually text
    const textBasedTypes = [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/yaml',
      'application/toml',
      'application/x-sh',
      'application/x-shellscript',
      'application/octet-stream',
      'image/svg+xml',
    ];
    
    return textBasedTypes.includes(lowerMime);
  }

  /**
   * Check if MIME type is HEIC/HEIF (iPhone photo format).
   */
  private isHeicMime(mime: string): boolean {
    if (!mime) return false;
    const lowerMime = mime.toLowerCase();
    return lowerMime === 'image/heic' || lowerMime === 'image/heif';
  }

  /**
   * Convert HEIC image to JPEG.
   * Returns the original file if conversion fails.
   */
  private async convertHeicToJpeg(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    try {
      const heicBlob = blobFromDataUrl(file.url, file.mime);
      if (!heicBlob) return file;

      // Native Capacitor transcode (iOS ImageIO / Android) first; null falls
      // back to the heic2any WASM path below so web/desktop keep working.
      const nativeJpegBlob = await convertHeicToJpegViaNative(heicBlob);
      const jpegBlob = nativeJpegBlob
        // Dynamic import to avoid loading heic2any unless needed
        ?? (await ((await import('heic2any')).default)({
          blob: heicBlob,
          toType: 'image/jpeg',
          quality: 0.9,
        }) as Blob);

      const jpegDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(jpegBlob);
      });

      let newFilename = file.filename;
      if (newFilename) {
        newFilename = newFilename.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
      }

      return {
        mime: 'image/jpeg',
        filename: newFilename,
        url: jpegDataUrl
      };
    } catch (error) {
      console.warn('Failed to convert HEIC to JPEG:', error);
      return file;
    }
  }

  /**
   * Normalize file part for sending to AI providers.
   * - Converts unsupported text MIME types to text/plain
   * - Converts HEIC/HEIF images to JPEG
   */
  private async normalizeFilePart(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    // Handle HEIC conversion
    if (this.isHeicMime(file.mime)) {
      return this.convertHeicToJpeg(file);
    }

    // Handle text MIME normalization
    if (!this.shouldNormalizeToTextPlain(file.mime)) {
      return file;
    }

    let normalizedUrl = file.url;
    
    // Update MIME type in data URL if present
    // Format: data:<mime>;base64,<content> or data:<mime>,<content>
    if (file.url.startsWith('data:')) {
      const commaIndex = file.url.indexOf(',');
      if (commaIndex !== -1) {
        const meta = file.url.substring(5, commaIndex); // after "data:"
        const content = file.url.substring(commaIndex); // includes comma
        
        // Replace the MIME type in meta, preserving ;base64 if present
        const newMeta = meta.replace(/^[^;,]+/, 'text/plain');
        normalizedUrl = `data:${newMeta}${content}`;
      }
    }

    return {
      mime: 'text/plain',
      filename: file.filename,
      url: normalizedUrl
    };
  }

  private async toNormalizedFilePartInput(file: FileInputLite): Promise<FilePartInput> {
    const normalized = await this.normalizeFilePart(file);
    let url = normalized.url;
    // Inline data/blob URLs must leave the prompt JSON before promptAsync /
    // createWithPrompt. Upload the bytes first and keep only a host file://
    // reference so the shared relay tunnel is not head-of-line blocked.
    if (needsPromptAttachmentUpload(url)) {
      const body = blobFromDataUrl(url, normalized.mime);
      if (!body) {
        throw new Error(`Failed to materialize attachment bytes for ${normalized.filename ?? 'file'}`);
      }
      const uploaded = await uploadPromptAttachmentBytes({
        body,
        mime: normalized.mime,
        filename: normalized.filename,
      });
      url = uploaded.url;
    }
    return {
      ...(file.id ? { id: file.id } : {}),
      type: 'file',
      mime: normalized.mime,
      filename: normalized.filename,
      url,
    };
  }

  /**
   * Build prompt parts using the instance's file normalizer.
   * Shared by sendMessage and combined createWithPrompt flows so file
   * normalization (MIME correction, HEIC conversion, inline blob handling)
   * stays consistent across both paths.
   */
  async buildMessageParts(params: Omit<Parameters<typeof _buildPromptParts>[0], never>): Promise<Array<TextPartInput | FilePartInput | AgentPartInputLite>> {
    return _buildPromptParts(params, (file) => this.toNormalizedFilePartInput(file));
  }

  async sendMessage(params: {
    id: string;
    providerID: string;
    modelID: string;
    text: string;
    prefaceText?: string;
    prefaceTextSynthetic?: boolean;
    agent?: string;
    variant?: string;
    files?: Array<FileInputLite>;
    /** Additional text/file parts to include (for batch sending queued messages) */
    additionalParts?: Array<{
      text: string;
      synthetic?: boolean;
      files?: Array<FileInputLite>;
    }>;
    messageId?: string;
    agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>;
    delivery?: 'steer' | 'queue';
    format?: {
      type: 'json_schema';
      schema: Record<string, unknown>;
      retryCount?: number;
    };
    directory?: string | null;
  }): Promise<string> {
    // Use the optimistic/client-generated ID as the real user message ID so SSE
    // can reconcile the echoed server message in-place.
    const messageId = params.messageId ?? ascendingId("msg");

    // Build parts using the shared builder
    const parts = await this.buildMessageParts({
      text: params.text,
      prefaceText: params.prefaceText,
      prefaceTextSynthetic: params.prefaceTextSynthetic,
      files: params.files,
      additionalParts: params.additionalParts,
      agentMentions: params.agentMentions,
    });

    const requestDirectory = this.normalizeCandidatePath(params.directory ?? null) ?? this.currentDirectory;

    if (params.format) {
      console.info('[git-generation][browser] send structured message', {
        sessionId: params.id,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        variant: params.variant,
        directory: requestDirectory,
        baseUrl: this.baseUrl,
        formatType: params.format.type,
      });
    }

    assertProviderCircuitClosed(params.providerID);

    const text = parts
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n") || params.text;
    const files = parts.flatMap((part) => {
      if (part.type !== "file" || typeof part.url !== "string") return [];
      return [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }];
    });
    const agents = parts.flatMap((part) => (
      part.type === "agent" && typeof part.name === "string" ? [{ name: part.name }] : []
    ));

    try {
      // Ticket 06/07: v2 prompt via Host shallow proxy. Idle uses delivery=steer;
      // busy same-session follow-up uses delivery=queue. Do not retry after a
      // transport failure: through a remote tunnel the POST may already be
      // running server-side even though the client lost the response.
      const inbox = await postSessionPrompt({
        sessionID: params.id,
        directory: requestDirectory ?? "",
        messageID: messageId,
        text,
        delivery: params.delivery,
        ...(files.length > 0 ? { files } : {}),
        ...(agents.length > 0 ? { agents } : {}),
        ...(params.agent || params.variant || params.format
          ? {
              metadata: {
                ...(params.agent ? { agent: params.agent } : {}),
                ...(params.variant ? { variant: params.variant } : {}),
                model: { providerID: params.providerID, modelID: params.modelID },
                ...(params.format ? { format: params.format } : {}),
              },
            }
          : {}),
      });
      recordProviderSuccess(params.providerID);
      return inbox.id;
    } catch (error) {
      recordProviderError(params.providerID, (error as Error & { status?: number }).status);
      throw error;
    }
  }

  async sendCommand(params: {
    id: string;
    providerID: string;
    modelID: string;
    command: string;
    arguments?: string;
    agent?: string;
    variant?: string;
    files?: Array<FileInputLite>;
    messageId?: string;
    directory?: string | null;
  }): Promise<string> {
    const tempMessageId = params.messageId ?? ascendingId("msg");

    const files: Array<{ uri: string; name?: string }> = [];
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        const normalized = await this.toNormalizedFilePartInput(file);
        files.push({ uri: normalized.url, ...(normalized.filename ? { name: normalized.filename } : {}) });
      }
    }

    void params.directory;
    const inbox = await this.client.session.command({
      sessionID: params.id,
      id: tempMessageId,
      command: params.command,
      arguments: params.arguments ?? '',
      ...(params.agent ? { agent: params.agent } : {}),
      model: {
        id: params.modelID,
        providerID: params.providerID,
        ...(params.variant ? { variant: params.variant } : {}),
      },
      ...(files.length > 0 ? { files } : {}),
    });
    return inbox.id || tempMessageId;
  }

  async abortSession(id: string): Promise<boolean> {
    await postSessionInterrupt({
      sessionID: id,
      directory: this.currentDirectory,
    });
    return true;
  }

  async shellSession(params: {
    sessionId: string;
    command: string;
    agent: string;
    model: { providerID: string; modelID: string };
    messageId?: string;
    directory?: string | null;
  }): Promise<{ info: Message; parts: Part[] }> {
    void params.directory;
    await this.client.session.shell({
      sessionID: params.sessionId,
      command: params.command,
      ...(params.messageId ? { id: params.messageId } : {}),
    });
    return {
      info: {
        id: params.messageId ?? "",
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: Date.now() },
        clientRole: "shell",
        agent: params.agent,
        modelID: params.model.modelID,
        providerID: params.model.providerID,
      },
      parts: [],
    };
  }

  async revertSession(sessionId: string, messageId: string, partId?: string, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    void partId;
    const revert = await postSessionRevertStage({
      sessionID: sessionId,
      directory: requestDirectory,
      messageID: messageId,
      files: true,
    });
    return {
      id: sessionId,
      time: { created: 0, updated: Date.now() },
      revert,
    } as Session;
  }

  async summarizeSession(sessionId: string, providerId: string, modelId: string, directory?: string | null): Promise<boolean> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    void providerId;
    void modelId;
    await postSessionCompact({
      sessionID: sessionId,
      directory: requestDirectory ?? "",
    });
    return true;
  }

  async unrevertSession(sessionId: string, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    await postSessionRevertClear({
      sessionID: sessionId,
      directory: requestDirectory,
    });
    return {
      id: sessionId,
      time: { created: 0, updated: Date.now() },
    } as Session;
  }

  async forkSession(sessionId: string, messageId?: string, directory?: string | null): Promise<Session> {
    void directory;
    console.info('[session-fork] SDK request starting', {
      sessionId,
      messageId: messageId ?? null,
      hasDirectory: Boolean(this.normalizeCandidatePath(directory) ?? this.currentDirectory),
    });
    const forkedSession = await this.client.session.fork({
      sessionID: sessionId,
      boundary: messageId
        ? { type: "before", messageID: messageId }
        : { type: "through" },
    });
    console.info('[session-fork] SDK request completed', {
      sessionId,
      messageId: messageId ?? null,
      forkedSessionId: forkedSession.id,
    });
    return projectSession(forkedSession);
  }

  async getSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return (await this.getSessionStatusForDirectory(this.currentDirectory ?? null)) ?? {};
  }

  /**
   * Returns the upstream `/session/status` map, or `null` if the fetch failed.
   *
   * `null` vs `{}` matters for reconnect resync: the server omits idle sessions
   * from the response, so an empty `{}` means "everything is idle" and a candidate
   * missing from the response is authoritatively idle. A network/HTTP failure must
   * not be conflated with that — return `null` so the caller can preserve state.
   */
  async getSessionStatusForDirectory(
    directory: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }> | null> {
    void directory;
    void signal;
    return null;
  }

  /**
   * Narrow wrapper around `v2.session.active` (OpenCode 1.18+).
   *
   * Three-state capability probe driven by the real HTTP response:
   * - `supported`: HTTP 200 with a validated membership map (sessionID → { type: "running" }).
   *   Absence from the map is authoritative inactive for this process.
   * - `unsupported`: HTTP 404 / 405 / 501 (older OpenCode without the endpoint).
   * - `unknown`: 401, 5xx, network failure, or malformed 200 body — caller must not
   *   treat this as empty success and should fall back to legacy `/session/status`.
   */
  async getSessionActive(signal?: AbortSignal): Promise<SessionActiveResult> {
    try {
      const rawMap = await this.client.session.active(signal ? { signal } : undefined);
      // HeyApi may nest the 200 payload as `{ data: map }` or return the map directly.
      const membershipSource =
        rawMap && typeof rawMap === "object" && "data" in rawMap && (rawMap as { data?: unknown }).data !== undefined
          ? (rawMap as { data: unknown }).data
          : rawMap;

      if (!membershipSource || typeof membershipSource !== "object" || Array.isArray(membershipSource)) {
        return { state: "unknown" };
      }

      const membership: SessionActiveMembership = {};
      for (const [sessionID, entry] of Object.entries(membershipSource as Record<string, unknown>)) {
        if (typeof sessionID !== "string" || sessionID.length === 0) {
          return { state: "unknown" };
        }
        if (!entry || typeof entry !== "object") {
          return { state: "unknown" };
        }
        const type = (entry as { type?: unknown }).type;
        if (type !== "running") {
          return { state: "unknown" };
        }
        membership[sessionID] = { type: "running" };
      }

      return { state: "supported", membership };
    } catch (error) {
      if (isUnsupportedStatus(clientErrorStatus(error))) {
        return { state: "unsupported" };
      }
      return { state: "unknown" };
    }
  }

  async getGlobalSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return (await this.getSessionStatusForDirectory(null)) ?? {};
  }

  /**
   * Get session activity from web server's in-memory tracking.
   * This is more reliable than getGlobalSessionStatus on visibility restore
   * because the web server tracks activity even when UI is not listening to SSE.
   */
  async getWebServerSessionActivity(): Promise<
    Record<string, { type: string }> | null
  > {
    try {
      const response = await runtimeFetch('/api/session-activity', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        return null;
      }

      return data as Record<string, { type: string }>;
    } catch {
      return null;
    }
  }

  // Tools
  async listToolIds(options?: { directory?: string | null }): Promise<string[]> {
    void options;
    throw v2CapabilityUnavailable('tool.ids');
  }

  // Permissions
  async replyToPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    options?: { message?: string; directory?: string | null; sessionID?: string }
  ): Promise<boolean> {
    const requestDirectory = this.normalizeCandidatePath(options?.directory ?? null) ?? this.currentDirectory;
    if (!options?.sessionID) {
      throw v2CapabilityUnavailable('permission.reply (sessionID required)');
    }
    await postSessionPermissionReply({
      sessionID: options.sessionID,
      requestID: requestId,
      reply,
      ...(options.message ? { message: options.message } : {}),
      directory: requestDirectory,
    });
    return true;
  }

  /**
   * Programmatically evaluate and (when approval is required) create a
   * permission request for a session via the V2 endpoint introduced in
   * OpenCode SDK v1.17.12. Wraps `session.permission.create`.
   *
   * Returns `{ id, effect }` on success, or `null` on any failure
   * (network error, 4xx/5xx response, malformed payload, or pre-v1.17.12
   * server without the V2 endpoint). Callers driving authoritative state
   * must treat `null` as "unknown — do not act" rather than "permission
   * allowed."
   *
   * Thin wrapper for future programmatic permission creation. The V1
   * `permission.list` / `permission.reply` flow used by the auto-accept
   * path is unchanged.
   */
  async createPermission(
    sessionID: string,
    action: string,
    resources: string[],
    options?: {
      id?: string;
      save?: string[];
      metadata?: Record<string, unknown>;
      source?: PermissionV2Source;
      agent?: string;
    }
  ): Promise<{ id: string; effect: PermissionV2Effect } | null> {
    try {
      const payload = await this.client.permission.create({
        sessionID,
        action,
        resources,
        ...(options?.id ? { id: options.id } : {}),
        ...(options?.save ? { save: options.save } : {}),
        ...(options?.metadata ? { metadata: options.metadata as PermissionV2Request["metadata"] } : {}),
        ...(options?.source ? { source: options.source } : {}),
        ...(options?.agent ? { agent: options.agent } : {}),
      });
      // Discriminated union narrowing on `error` (see fetchPermission).
      if (!payload || typeof payload.id !== "string") return null;
      return { id: payload.id, effect: payload.effect };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a pending permission request owned by a session via the V2
   * endpoint introduced in OpenCode SDK v1.17.12. Wraps
   * `session.permission.get`.
   *
   * Returns a tagged `FetchPermissionResult` so the caller can distinguish
   * a confirmed-resolved permission (HTTP 404) from a fetch failure
   * (network error, malformed response, or pre-v1.17.12 server without
   * the V2 endpoint). The auto-accept flow uses this distinction to drop
   * resolved permissions from the resync output, preventing stale
   * `permission.list` entries from sticking around in the UI.
   */
  async fetchPermission(
    sessionID: string,
    requestID: string,
  ): Promise<FetchPermissionResult> {
    try {
      // The V2 path is session-scoped and does not require a `directory`
      // parameter. The client-scoped directory (set via setDirectory) is
      // honored by the underlying SDK client when the call is routed.
      const payload = await this.client.permission.get({
        sessionID,
        requestID,
      });
      // The SDK returns a discriminated union on `error`/`data` (HeyApi
      // `RequestResult` with `ThrowOnError = false`). The error branch
      // collapses `data` to `undefined`; the data branch returns the
      // 200-response payload as `{ data: PermissionV2Request }`. Narrow
      // via `error` first, then unwrap the inner `data` field.
      if (payload !== undefined) {
        return { state: "ok", permission: payload };
      }
      // On the error branch the server has answered but the request was
      // not found. V2SessionPermissionGetErrors maps 404 to
      // `PermissionNotFoundError`, so the only server-confirmed
      // "no longer pending" signal we have is HTTP 404.
      return { state: "unknown" };
    } catch (error) {
      // Network failure, pre-v1.17.12 server, or runtimeFetch throwing.
      // Treat as "unknown" — caller must decide what to do (auto-accept
      // fails closed, but the permission stays in the resync output so
      // the user can still act on it).
      if (isPermissionNotFoundError(error) || clientErrorStatus(error) === 404) {
        return { state: "resolved" };
      }
      return { state: "unknown" };
    }
  }

  /**
   * Throws on fetch/SDK failure. Callers that drive authoritative state from
   * the result (e.g. reconnect resync) must let the throw propagate so they
   * can preserve existing state instead of conflating "fetch failed" with
   * "server returned no pending permissions".
   */
  async listPendingPermissions(options?: { directories?: Array<string | null | undefined> }): Promise<PermissionRequest[]> {
    const fetches: Array<Promise<PermissionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<PermissionRequest[]> => {
      const result = await this.client.permission.request.list(locationOf(directory));
      if (!result || !Array.isArray(result.data)) {
        throw new Error(`permission.list failed: ${formatSdkError(result)}`);
      }
      return result.data.flatMap((item) => {
        const mapped = toLocalPermission(item);
        return mapped ? [mapped] : [];
      });
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: PermissionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Questions ("ask" tool)
  async replyToQuestion(requestId: string, answers: string[] | string[][], directory?: string | null, sessionID?: string): Promise<boolean> {
    const normalizedAnswers: string[][] = (() => {
      if (!Array.isArray(answers) || answers.length === 0) {
        return [];
      }
      if (Array.isArray(answers[0])) {
        return answers as string[][];
      }
      return [answers as string[]];
    })();

    void directory;
    if (!sessionID) {
      throw v2CapabilityUnavailable('question.reply (sessionID required)');
    }
    await this.client.question.reply({
      requestID: requestId,
      sessionID,
      answers: normalizedAnswers,
    });
    return true;
  }

  async rejectQuestion(requestId: string, sessionID?: string): Promise<boolean> {
    if (!sessionID) {
      throw v2CapabilityUnavailable('question.reject (sessionID required)');
    }
    await this.client.question.reject({
      requestID: requestId,
      sessionID,
    });
    return true;
  }

  /**
   * Throws on fetch/SDK failure. See {@link listPendingPermissions} for
   * rationale — resync paths preserve state on throw via outer try/catch
   * instead of conflating failure with an empty server response.
   */
  async listPendingQuestions(options?: { directories?: Array<string | null | undefined> }): Promise<QuestionRequest[]> {
    const fetches: Array<Promise<QuestionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<QuestionRequest[]> => {
      const result = await this.client.question.request.list(locationOf(directory));
      if (!result || !Array.isArray(result.data)) {
        throw new Error(`question.list failed: ${formatSdkError(result)}`);
      }
      return result.data as unknown as QuestionRequest[];
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: QuestionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Configuration
  clearConfigCache(): void {
    this.configCacheGeneration += 1;
    this.configInFlight.clear();
    this.configCache.clear();
  }

  private clearHealthCache(): void {
    this.healthCacheGeneration += 1;
    this.healthInFlight.clear();
    this.healthCache.clear();
  }

  async getConfig(directory?: string | null): Promise<Config> {
    const effectiveDirectory = this.normalizeCandidatePath(directory) ?? directory ?? this.currentDirectory ?? undefined;
    const key = effectiveDirectory ?? '';
    const cached = this.configCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      markStartupTrace('opencodeClient.getConfig:cacheHit', { directory: effectiveDirectory ?? null });
      return cached.config;
    }

    const existing = this.configInFlight.get(key);
    if (existing) {
      markStartupTrace('opencodeClient.getConfig:deduped', { directory: effectiveDirectory ?? null });
      return existing;
    }

    const generation = this.configCacheGeneration;
    const request = (async () => {
      markStartupTrace('opencodeClient.getConfig:start', { directory: effectiveDirectory ?? null });
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const entries = await this.client.config.get(locationOf(effectiveDirectory));
      if (!Array.isArray(entries)) throw new Error('Failed to get config');
      const config = mergeConfigDocuments(entries);
      const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
      markStartupTrace('opencodeClient.getConfig:end', {
        directory: effectiveDirectory ?? null,
        durationMs: Math.round(ended - started),
      });
      if (generation === this.configCacheGeneration) {
        this.configCache.set(key, { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
      }
      return config;
    })();

    this.configInFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.configInFlight.get(key) === request) {
        this.configInFlight.delete(key);
      }
    }
  }

  async updateConfig(config: Record<string, unknown>): Promise<Config> {
    // IMPORTANT: Do NOT pass directory parameter for config updates
    // The config should be global, not directory-specific
    void config;
    throw v2CapabilityUnavailable('config.update');
  }

  /**
   * Update config with a partial modification function.
   * This handles the GET-modify-PATCH pattern required by the upstream API.
   *
   * NOTE: This method is deprecated for agent configuration.
   * Use backend endpoints at /api/config/agents/* instead, which write directly to files.
   *
   * @param modifier Function that receives current config and returns modified config
   * @returns Updated config from server
   */
  async updateConfigPartial(modifier: (config: Config) => Config): Promise<Config> {
    const currentConfig = await this.getConfig();
    const updatedConfig = modifier(currentConfig);
    const result = await this.updateConfig(updatedConfig);
    return result;
  }

  async getProviders(): Promise<{
    providers: Provider[];
    default: { [key: string]: string };
  }> {
    return this.getProvidersForConfig(this.currentDirectory);
  }

  async getProvidersForConfig(directory?: string | null): Promise<{
    providers: Provider[];
    default: { [key: string]: string };
  }> {
    const effectiveDirectory = directory === undefined
      ? this.currentDirectory ?? undefined
      : this.normalizeCandidatePath(directory) ?? undefined;
    const key = effectiveDirectory ?? '';

    const existing = this.configProvidersInFlight.get(key);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const response = await this.client.provider.list(locationOf(effectiveDirectory));
      if (!response || !Array.isArray(response.data)) {
        throw new Error(`config.providers failed: ${formatSdkError(response)}`);
      }
      const defaults: { [key: string]: string } = {};
      try {
        const modelDefault = await this.client.model.default(locationOf(effectiveDirectory));
        if (modelDefault?.data) {
          defaults[modelDefault.data.providerID] = modelDefault.data.modelID;
        }
      } catch {
        // default model is optional; keep providers observable
      }
      return { providers: response.data, default: defaults };
    })();

    this.configProvidersInFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.configProvidersInFlight.delete(key);
    }
  }

  // App Management - using config endpoint since /app doesn't exist in this version
  async getApp(): Promise<App> {
    // Return basic app info from config
    const config = await this.getConfig();
    return {
      version: "0.0.3", // from the OpenAPI spec
      config
    };
  }

  async initApp(): Promise<boolean> {
    try {
      // Just check if we can connect since there's no init endpoint
      return await this.checkHealth();
    } catch {
      return false;
    }
  }

  // Agent Management
  /**
   * Throws on fetch/SDK failure so caller-side retry loops (see
   * useAgentsStore) can observe failure and retry; silently returning an
   * empty list would defeat retries and clear the cached agent list.
   */
  async listAgents(directory?: string | null, signal?: AbortSignal): Promise<Agent[]> {
    // Pass the directory explicitly so we don't depend on (and serialize behind)
    // withDirectory's shared context queue. Concurrent callers for the same
    // directory (e.g. config store + agents store at startup) share one request.
    const effectiveDirectory = directory === undefined
      ? this.currentDirectory ?? undefined
      : this.normalizeCandidatePath(directory) ?? undefined;
    const key = effectiveDirectory ?? '';

    if (!signal) {
      const existing = this.listAgentsInFlight.get(key);
      if (existing) return existing;
    }

    const request = (async () => {
      const timeout = createTimeoutSignal(LIST_AGENTS_TIMEOUT_MS);
      const merged = mergeAbortSignals(signal ? [signal, timeout.signal] : [timeout.signal]);
      try {
        const params = locationOf(effectiveDirectory);
        const response = await this.client.agent.list(params, { signal: merged.signal });
        if (!response || !Array.isArray(response.data)) {
          throw new Error(`app.agents failed: ${formatSdkError(response)}`);
        }
        // SDK gap / endpoint drift: current OpenCode exposes the authoritative
        // agent list at /agent, while app.agents can be empty on some runtimes.
        return response.data;
      } finally {
        timeout.cleanup();
        merged.cleanup();
      }
    })();

    if (signal) return request;
    this.listAgentsInFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.listAgentsInFlight.delete(key);
    }
  }

  // SSE infrastructure removed — EventPipeline in sync/event-pipeline.ts handles
  // all SSE event ingestion via the SDK's global.event() async iterator.

  // File Operations
  async readFile(path: string): Promise<string> {
    try {
      const bytes = await this.client.file.read({
        path,
        ...locationOf(this.currentDirectory),
      });
      return new TextDecoder().decode(bytes);
    } catch {
      // Return placeholder for development
      return `// Content of ${path}\n// This would be loaded from the server`;
    }
  }

  async listFiles(directory?: string): Promise<Record<string, unknown>[]> {
    try {
      const targetDir = directory || this.currentDirectory || '/';
      const response = await this.client.file.list({
        path: targetDir,
        ...locationOf(this.currentDirectory),
      });
      const data = response.data;
      return Array.isArray(data) ? data as Record<string, unknown>[] : [];
    } catch {
      // Return mock data for development
      return [];
    }
  }

  // Command Management
  async listCommands(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; source?: string }>> {
    const response = await this.client.command.list(locationOf(this.currentDirectory));
    const commands = response.data;
    if (!Array.isArray(commands)) {
      throw new Error(`command.list failed: ${formatSdkError(response)}`);
    }
    // Return only lightweight info for autocomplete
    return commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      agent: cmd.agent,
      model: cmd.model ? `${cmd.model.providerID}/${cmd.model.id}` : undefined,
      source: undefined,
      // Intentionally excluding template to keep memory usage low
    }));
  }

  async listCommandsWithDetails(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; source?: string; template?: string }>> {
    const response = await this.client.command.list(locationOf(this.currentDirectory));
    const commands = response.data;
    if (!Array.isArray(commands)) {
      throw new Error(`command.list failed: ${formatSdkError(response)}`);
    }
    // Return full command details including template
    return commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      agent: cmd.agent,
      model: cmd.model ? `${cmd.model.providerID}/${cmd.model.id}` : undefined,
      source: undefined,
      template: cmd.template,
    }));
  }

  async listSkillsWithDetails(): Promise<Array<{ name: string; description?: string; location: string; content?: string }>> {
    try {
      const response = await this.client.skill.list(locationOf(this.currentDirectory));
      const data = response.data;
      if (!Array.isArray(data)) {
        return [];
      }

      const skills: Array<{ name: string; description?: string; location: string; content?: string }> = [];
      for (const item of data) {
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          const location = typeof item.location === 'string' ? item.location : '';
          if (!name || !location) {
            continue;
          }
          const skill: { name: string; description?: string; location: string; content?: string } = { name, location };
          if (typeof item.description === 'string') skill.description = item.description;
          if (typeof item.content === 'string') skill.content = item.content;
          skills.push(skill);
      }
      return skills;
    } catch {
      return [];
    }
  }

  async getCommandDetails(name: string): Promise<{ name: string; template: string; description?: string; agent?: string; model?: string } | null> {
    try {
      const response = await this.client.command.list(locationOf(this.currentDirectory));

      if (response.data) {
        const command = response.data.find((cmd) => cmd.name === name);
        if (command) {
          return {
            name: command.name,
            template: command.template,
            description: command.description,
            agent: command.agent,
            model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Lightweight readiness check. Full diagnostics still live at /health.
  async checkHealth(): Promise<boolean> {
    const runtimeKey = getRuntimeKey();
    const cached = this.healthCache.get(runtimeKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.healthy;
    }

    const existing = this.healthInFlight.get(runtimeKey);
    if (existing) {
      return existing;
    }

    const generation = this.healthCacheGeneration;
    const request = (async () => {
      let healthy = false;
      try {
        const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.replace(/\/+$/, '') : this.baseUrl;
        const healthUrl = normalizedBase === '/api' || normalizedBase.endsWith('/api')
          ? '/api/opencode/health'
          : `${normalizedBase}/opencode/health`;
        markStartupTrace('opencodeClient.checkHealth:url', { baseUrl: this.baseUrl, healthUrl });
        const timeout = createTimeoutSignal(OPENCODE_HEALTH_TIMEOUT_MS);
        const response = await runtimeFetch(healthUrl, { signal: timeout.signal }).finally(timeout.cleanup);
        markStartupTrace('opencodeClient.checkHealth:response', { status: response.status });
        if (response.ok) {
          const healthData = await response.json();
          markStartupTrace('opencodeClient.checkHealth:result', { healthy: healthData?.healthy });
          healthy = healthData?.healthy === true;
        }
      } catch {
        healthy = false;
      }

      const isCurrentRuntime = generation === this.healthCacheGeneration && runtimeKey === getRuntimeKey();
      if (!isCurrentRuntime) return false;

      this.healthCache.set(runtimeKey, {
        healthy,
        expiresAt: Date.now() + (healthy ? OPENCODE_HEALTH_CACHE_TTL_MS : OPENCODE_HEALTH_FAILURE_CACHE_TTL_MS),
      });
      return healthy;
    })();

    this.healthInFlight.set(runtimeKey, request);
    try {
      return await request;
    } finally {
      if (this.healthInFlight.get(runtimeKey) === request) {
        this.healthInFlight.delete(runtimeKey);
      }
    }
  }

  // File System Operations
  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean }
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles?.createDirectory) {
      try {
        return await desktopFiles.createDirectory(dirPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || 'Failed to create directory');
      }
    }

    const payload = {
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    };

    const response = await runtimeFetch(`${this.baseUrl}/fs/mkdir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create directory' }));
      throw new Error(error.error || 'Failed to create directory');
    }

    const result = await response.json();
    return result;
  }

  async cloneRepository(input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null }): Promise<{ success: boolean; path: string; output?: string }> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/clone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to clone repository' }));
      throw new Error(error.error || 'Failed to clone repository');
    }

    return await response.json();
  }

  async listLocalDirectory(directoryPath: string | null | undefined, options?: { respectGitignore?: boolean }): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === 'string' ? normalizeFsPath(directoryPath.trim()) : '';
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? '1' : '0'}`;
    const now = Date.now();
    const cached = this.listDirectoryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.entries;
    }

    const inFlight = this.listDirectoryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const task = (async () => {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles) {
      try {
        const result = await desktopFiles.listDirectory(directoryPath || '', options);
        if (!result || !Array.isArray(result.entries)) {
          return [];
        }
        const entries = result.entries.map<FilesystemEntry>((entry) => ({
          name: entry.name,
          path: normalizeFsPath(entry.path),
          isDirectory: !!entry.isDirectory,
          isFile: !entry.isDirectory,
          isSymbolicLink: false,
        }));
        this.listDirectoryCache.set(cacheKey, {
          entries,
          expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
        });
        return entries;
      } catch (error) {
        console.error('Failed to list directory contents:', error);
        throw error;
      }
    }

    try {
      const params = new URLSearchParams();
      if (directoryPath && directoryPath.trim().length > 0) {
        params.set('path', directoryPath);
      }
      if (options?.respectGitignore) {
        params.set('respectGitignore', 'true');
      }
      const query = params.toString();
      const response = await runtimeFetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ''}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message = typeof error.error === 'string' ? error.error : 'Failed to list directory';
        throw new Error(message);
      }

      const result = await response.json();
      if (!result || !Array.isArray(result.entries)) {
        return [];
      }

      const entries = result.entries as FilesystemEntry[];
      this.listDirectoryCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
      });
      return entries;
    } catch (error) {
      console.error('Failed to list directory contents:', error);
      throw error;
    }
    })();

    const trackedTask = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === trackedTask) {
        this.listDirectoryInFlight.delete(cacheKey);
      }
    });
    this.listDirectoryInFlight.set(cacheKey, trackedTask);
    return trackedTask;
  }

  async searchFiles(
    query: string,
    options?: {
      directory?: string | null;
      limit?: number;
      includeHidden?: boolean;
      respectGitignore?: boolean;
      dirs?: boolean;
      type?: 'file' | 'directory';
    }
  ): Promise<ProjectFileSearchHit[]> {
    const directory = typeof options?.directory === 'string' && options.directory.trim().length > 0
      ? options.directory.trim()
      : this.currentDirectory;
    const normalizedDirectory = directory ? normalizeFsPath(directory) : null;

    try {
      const response = await this.client.file.find({
        query,
        ...locationOf(directory),
        limit: typeof options?.limit === 'number' && Number.isFinite(options.limit) ? options.limit : undefined,
        type: options?.type,
      });

      const items = Array.isArray(response?.data) ? response.data : [];
      return items.map<ProjectFileSearchHit>((item) => {
        const normalizedRelativePath = normalizeFsPath(item.path);
        const name = normalizedRelativePath.split('/').filter(Boolean).pop() || normalizedRelativePath;
        const normalizedPath = normalizedDirectory
          ? normalizeFsPath(`${normalizedDirectory}/${normalizedRelativePath}`)
          : normalizeFsPath(normalizedRelativePath);

        return {
          name,
          path: normalizedPath,
          relativePath: normalizedRelativePath,
          extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
          isDirectory: item.type === 'directory',
        };
      });
    } catch (error) {
      console.error('Failed to search files:', error);
      throw error;
    }
  }

  async getFilesystemHome(): Promise<string | null> {
    // The injected desktop home describes the LOCAL machine. It is only a
    // valid answer while the active runtime is the local one — after an
    // in-place switch to a remote host the home must come from that host's
    // /api/fs/home, not from the local Electron global.
    const runtimeKey = getRuntimeKey();
    if (!runtimeKey || runtimeKey === 'local') {
      const desktopHome = await getDesktopHomeDirectory();
      if (desktopHome) {
        return desktopHome;
      }
    }

    try {
      const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to resolve home directory';
        throw new Error(message);
      }

      const payload = await response.json();
      if (payload && typeof payload.home === 'string' && payload.home.length > 0) {
        return payload.home;
      }
      return null;
    } catch (error) {
      console.warn('Failed to resolve filesystem home directory:', error);
      return null;
    }
  }

  async setOpenCodeWorkingDirectory(directoryPath: string | null | undefined): Promise<DirectorySwitchResult | null> {
    if (!directoryPath || typeof directoryPath !== 'string' || !directoryPath.trim()) {
      console.warn('[OpencodeClient] setOpenCodeWorkingDirectory: invalid path', directoryPath);
      return null;
    }

    const url = `${this.baseUrl}/opencode/directory`;
    console.log('[OpencodeClient] POST', url, 'with path:', directoryPath);

    try {
      const response = await runtimeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: directoryPath })
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const error = payload ?? {};
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to update OpenCode working directory';
        throw new Error(message);
      }

      if (payload && typeof payload === 'object') {
        return payload as DirectorySwitchResult;
      }

      return {
        success: true,
        restarted: false,
        path: directoryPath
      };
    } catch (error) {
      console.warn('Failed to update OpenCode working directory:', error);
      throw error;
    }
  }
}

// Exported singleton instance
export const opencodeClient = new OpencodeService();

// Exported types
