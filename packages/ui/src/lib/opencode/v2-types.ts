/**
 * OpenCode v2 domain types and the unique local Message/Part render projection.
 *
 * Authority:
 * - Request/response domain types come from the real `@opencode-ai/client`.
 * - Transcript rendering uses the local Message/Part projection below.
 *   That projection is the contract `session-projection-api.ts` normalize
 *   already emits (`{ info, parts }` records). It is not a copy of the
 *   1.18.4 SDK `Message` / `Part` unions.
 */

import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  FileDiffInfo,
  FileSystemEntry,
  LocationGetOutput,
  McpStatusConnected,
  McpStatusDisabled,
  McpStatusFailed,
  McpStatusNeedsAuth,
  McpStatusPending,
  ModelInfo,
  ModelRef,
  OpenCodeClient,
  PermissionEffect,
  PermissionRequest as V2PermissionRequest,
  PermissionRule,
  PermissionRuleset,
  PermissionSource,
  ProjectCurrent,
  ProviderInfo,
  SessionActive,
  SessionInboxUser,
  SessionInfo,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionRevert,
  SessionStatus,
  SkillInfo,
  TokenUsageInfo,
} from "@opencode-ai/client";

export type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  FileDiffInfo,
  FileSystemEntry,
  LocationGetOutput,
  McpStatusConnected,
  McpStatusDisabled,
  McpStatusFailed,
  McpStatusNeedsAuth,
  McpStatusPending,
  ModelInfo,
  ModelRef,
  OpenCodeClient,
  PermissionEffect,
  PermissionRule,
  PermissionRuleset,
  PermissionSource,
  ProjectCurrent,
  ProviderInfo,
  SessionActive,
  SessionInboxUser,
  SessionInfo,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionRevert,
  SessionStatus,
  SkillInfo,
  TokenUsageInfo,
};

/** Real v2 client instance produced by `OpenCode.make(...)`. */
export type V2Client = OpenCodeClient;

/**
 * Session row for existing directory/sidebar callers.
 * Based on v2 `SessionInfo`, with catalog fields kept optional so current
 * list/SSE payloads still type-check until sync finishes its cutover.
 */
export type Session = Omit<SessionInfo, "location" | "cost" | "tokens" | "time" | "projectID" | "title"> & {
  projectID?: string;
  title?: string;
  location?: SessionInfo["location"];
  cost?: SessionInfo["cost"];
  tokens?: SessionInfo["tokens"];
  time?: Partial<SessionInfo["time"]> & { compacting?: number };
  directory?: string;
  metadata?: Record<string, unknown>;
  slug?: string;
  share?: { url?: string };
  version?: string;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
};

/**
 * Local name kept for existing `OpencodeClient` type-only callers.
 * `experimental.session.list` is still a sync/client runtime cutover.
 */
export type OpencodeClient = OpenCodeClient;

/** Agent permission document. v2 stores this as `PermissionRuleset`. */
export type PermissionConfig = PermissionRuleset | Record<string, unknown>;

/** v2 agent catalog row, plus extras settings/composer already read. */
export type Agent = AgentInfo & {
  native?: boolean;
  options?: Record<string, unknown>;
  prompt?: string;
  variant?: string;
  permission?: PermissionConfig;
  model?: ModelRef & { modelID?: string };
  temperature?: number | null;
  topP?: number | null;
  top_p?: number | null;
};

/** Provider catalog model row used by `Provider['models']` callers. */
export type ProviderModel = ModelInfo & {
  [key: string]: unknown;
};

/** v2 provider catalog row, plus the models map config UI already reads. */
export type Provider = ProviderInfo & {
  models?: Record<string, ProviderModel>;
  source?: string;
  env?: string[];
  options?: Record<string, unknown>;
};

/** MCP runtime status. `needs_client_registration` is a local UI extra. */
export type McpStatusNeedsClientRegistration = {
  status: "needs_client_registration";
  error?: string;
};

export type McpStatus =
  | McpStatusConnected
  | McpStatusPending
  | McpStatusDisabled
  | McpStatusFailed
  | McpStatusNeedsAuth
  | McpStatusNeedsClientRegistration;

/** Todo item projected from todowrite/todoread tool output. */
export type Todo = {
  content: string;
  status: string;
  priority?: string;
  id?: string;
};

/**
 * Merged v2 config document. `config.get` returns `ConfigEntry[]`;
 * OpencodeService folds document entries into one object for callers.
 */
type ConfigDocumentInfo = ConfigEntry extends { info: infer Info } ? Info : Record<string, unknown>;
export type Config = ConfigDocumentInfo & {
  [key: string]: unknown;
};

/** v2 file diff row. Local name kept for `getSessionDiff` callers. */
export type SnapshotFileDiff = FileDiffInfo;

/** v2 permission request row. */
export type PermissionV2Request = V2PermissionRequest;
export type PermissionV2Effect = PermissionEffect;
export type PermissionV2Source = PermissionSource;

/** Prompt text part built by `buildMessageParts`. */
export type TextPartInput = {
  type: "text";
  text: string;
  synthetic?: boolean;
};

/** Prompt file part built by `buildMessageParts`. */
export type FilePartInput = {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
};

/** Prompt agent mention built by `buildMessageParts`. */
export type AgentPartInput = {
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

export type MessageRole = "user" | "assistant";

/**
 * Projection-only card role. v2 `SessionMessage.Info` variants that are not
 * user/assistant content still render through Message+Part.
 */
export type MessageClientRole =
  | MessageRole
  | "compaction"
  | "agent-switched"
  | "model-switched"
  | "location-switched"
  | "shell"
  | "skill"
  | "system";

/**
 * Token usage on a projected message.
 * Compatible with v2 `TokenUsageInfo`; catalog/SSE rows may omit fields.
 */
export type MessageTokens = {
  [K in keyof TokenUsageInfo]?: TokenUsageInfo[K] extends { read: number; write: number }
    ? { read?: number; write?: number }
    : TokenUsageInfo[K];
};

/**
 * Unique local message projection.
 * Compatible with `normalizeSessionProjectionMessage` `info`.
 */
export type Message = {
  id: string;
  sessionID: string;
  role: MessageRole;
  time: {
    created: number;
    completed?: number;
    start?: number;
    end?: number;
  };
  modelID?: string;
  providerID?: string;
  agent?: string;
  parentID?: string;
  finish?: string;
  error?: unknown;
  tokens?: MessageTokens;
  cost?: number;
  mode?: string;
  variant?: string;
  path?: { cwd?: string; root?: string };
  model?: { providerID?: string; modelID?: string; variant?: string };
  system?: string;
  summary?: unknown;
  clientRole?: MessageClientRole;
  parts?: Part[];
  [key: string]: unknown;
};

type ProjectionPartBase = {
  id: string;
  sessionID: string;
  messageID: string;
  text?: string;
};

/** Normalize output for user/assistant/system text. */
export type TextPart = ProjectionPartBase & {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start?: number; end?: number };
  metadata?: Record<string, unknown>;
};

/** Normalize output for assistant reasoning. */
export type ReasoningPart = ProjectionPartBase & {
  type: "reasoning";
  text: string;
  time?: { start?: number; end?: number };
  metadata?: Record<string, unknown>;
};

/** Normalize output for user file attachments. */
export type FilePart = ProjectionPartBase & {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: Record<string, unknown>;
};

/**
 * Tool-part state after normalize. Renderers read status/input/output/metadata;
 * extra fields stay intact for tool-specific cards.
 */
export type ToolState = {
  status: string;
  input: unknown;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  time?: { start?: number; end?: number; compacted?: number };
  raw?: string;
  [key: string]: unknown;
};

/** Normalize output for assistant tool content. */
export type ToolPart = ProjectionPartBase & {
  type: "tool";
  tool: string;
  callID: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

/** Normalize output for `SessionMessage.compaction`. */
export type CompactionPart = ProjectionPartBase & {
  type: "compaction";
  status: "running" | "completed" | "failed";
  reason: "auto" | "manual";
  summary?: string;
  recent?: string;
  error?: { type: string; message: string };
};

/** Normalize output for agent mentions and switch cards. */
export type AgentPart = ProjectionPartBase & {
  type: "agent";
  name?: string;
  source?: Record<string, unknown>;
};

/** Normalize output for step markers. */
export type StepPart = ProjectionPartBase & {
  type: "step-start" | "step-finish";
};

/** Normalize output for remaining named cards. */
export type NamedProjectionPart = ProjectionPartBase & {
  type: "patch" | "snapshot" | "retry" | "subtask" | "shell" | "skill" | "system";
  [key: string]: unknown;
};

/**
 * Catch-all for other normalize cards (agent-switched, model-switched, …).
 * Kept out of the `Part` discriminant so `type === "tool"` still narrows.
 */
export type ProjectionPart = ProjectionPartBase & {
  type: string;
  text?: string;
  state?: ToolState;
  time?: { start?: number; end?: number };
  [key: string]: unknown;
};

/**
 * Unique local part projection.
 * Compatible with `normalizeSessionProjectionMessage` `parts`.
 */
export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | CompactionPart
  | AgentPart
  | StepPart
  | NamedProjectionPart;

/** One normalize record: the only Message+Part pair this facade returns. */
export type ProjectedSessionMessage = {
  info: Message;
  parts: Part[];
};

/** Project a v2 session row for existing directory-based callers. */
export function projectSession(info: SessionInfo): Session {
  return {
    ...info,
    directory: info.location?.directory,
  };
}

/** Fold v2 config documents into one object. Later documents win. */
export function mergeConfigDocuments(entries: readonly ConfigEntry[]): Config {
  const merged: Config = {};
  for (const entry of entries) {
    const record = entry as { type?: string; info?: Record<string, unknown> };
    if (!record || record.type !== "document" || !record.info || typeof record.info !== "object") {
      continue;
    }
    Object.assign(merged, record.info);
  }
  return merged;
}
