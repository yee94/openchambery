/**
 * Cap permission auto-accept client for Lynx.
 * Routes: GET /api/permission-auto-accept, PUT /api/permission-auto-accept/sessions/:sessionId
 * Lineage: Cap stores/utils/permissionAutoAccept.ts (nearest explicit ancestor).
 * Server runtime is authoritative for Cap web; Lynx also auto-replies when enabled
 * so pending cards clear without inventing APIs. Failure ≠ fake-success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { replyLynxPermission, type LynxPermissionReply } from './pendingCards';
import type { LynxPermissionRequest } from './messageParts';

export type LynxPermissionAutoAcceptMap = Record<string, boolean>;

export type LynxSessionLineageNode = {
  id: string;
  parentID?: string | null;
};

export type LynxPermissionAutoAcceptSnapshotResult =
  | { status: 'ok'; sessions: LynxPermissionAutoAcceptMap }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

export type LynxPermissionAutoAcceptToggleArgs = {
  permissionScopeSessionId: string | null;
  newSessionDraftOpen: boolean;
  draftPermissionAutoAcceptEnabled: boolean;
  permissionAutoAcceptEnabled: boolean;
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void;
  setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
  onOpenSessionFirst: () => void;
  onToggleFailed: () => void;
};

type PermissionAction = 'allow' | 'ask' | 'deny';

type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

type PermissionAgent = {
  name?: unknown;
  permission?: unknown;
};

const isPermissionAction = (value: unknown): value is PermissionAction => (
  value === 'allow' || value === 'ask' || value === 'deny'
);

const normalizePermissionRules = (value: unknown): PermissionRule[] => {
  if (isPermissionAction(value)) {
    return [{ permission: '*', pattern: '*', action: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry): PermissionRule[] => {
      if (!entry || typeof entry !== 'object') return [];
      const rule = entry as Partial<PermissionRule>;
      return typeof rule.permission === 'string'
        && typeof rule.pattern === 'string'
        && isPermissionAction(rule.action)
        ? [{ permission: rule.permission, pattern: rule.pattern, action: rule.action }]
        : [];
    });
  }
  if (!value || typeof value !== 'object') return [];
  const rules: PermissionRule[] = [];
  for (const [permission, config] of Object.entries(value)) {
    if (permission === '__originalKeys') continue;
    if (isPermissionAction(config)) {
      rules.push({ permission, pattern: '*', action: config });
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    for (const [pattern, action] of Object.entries(config)) {
      if (isPermissionAction(action)) rules.push({ permission, pattern, action });
    }
  }
  return rules;
};

const canPermissionRulesPrompt = (permission: unknown): boolean => {
  const rules = normalizePermissionRules(permission);
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.permission === '*' && rule.pattern === '*') return rule.action === 'ask';
    if (rule.action === 'ask') return true;
  }
  return true;
};

/** Cap shouldShowPermissionAutoAcceptControl — unknown keeps control visible. */
export const shouldShowLynxPermissionAutoAcceptControl = (
  agents: readonly PermissionAgent[],
  currentAgentName: string | undefined,
): boolean => {
  const name = currentAgentName?.trim();
  if (!name) {
    return agents.length === 0 || agents.some((agent) => canPermissionRulesPrompt(agent.permission));
  }
  const agent = agents.find((entry) => entry?.name === name);
  return agent ? canPermissionRulesPrompt(agent.permission) : true;
};

const buildSessionMap = (
  sessions: readonly LynxSessionLineageNode[],
): Map<string, LynxSessionLineageNode> => {
  const map = new Map<string, LynxSessionLineageNode>();
  for (const session of sessions) {
    map.set(session.id, session);
  }
  return map;
};

const resolveLineage = (
  sessionID: string,
  sessions: readonly LynxSessionLineageNode[],
  sessionById?: ReadonlyMap<string, LynxSessionLineageNode>,
): string[] => {
  const map = sessionById ?? buildSessionMap(sessions);
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionID;
  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = map.get(current)?.parentID ?? undefined;
  }
  return result;
};

/** Cap autoRespondsPermission — nearest explicit ancestor wins. */
export const lynxAutoRespondsPermission = (input: {
  autoAccept: LynxPermissionAutoAcceptMap;
  sessions: readonly LynxSessionLineageNode[];
  sessionById?: ReadonlyMap<string, LynxSessionLineageNode>;
  sessionID: string;
}): boolean => {
  const { autoAccept, sessions, sessionById, sessionID } = input;
  if (Object.keys(autoAccept).length === 0) return false;
  const lineage = resolveLineage(sessionID, sessions, sessionById);
  for (const id of lineage) {
    if (!Object.prototype.hasOwnProperty.call(autoAccept, id)) continue;
    return autoAccept[id] === true;
  }
  return false;
};

const parseSnapshot = (payload: unknown): LynxPermissionAutoAcceptMap | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const sessionsRaw = (payload as { sessions?: unknown }).sessions;
  if (!sessionsRaw || typeof sessionsRaw !== 'object' || Array.isArray(sessionsRaw)) return null;
  const sessions: LynxPermissionAutoAcceptMap = {};
  for (const [sessionId, enabled] of Object.entries(sessionsRaw)) {
    if (sessionId && typeof enabled === 'boolean') sessions[sessionId] = enabled;
  }
  return sessions;
};

export async function fetchLynxPermissionAutoAccept(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
): Promise<LynxPermissionAutoAcceptSnapshotResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/permission-auto-accept', { method: 'GET' });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `permission-auto-accept GET failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    const sessions = parseSnapshot(payload);
    if (!sessions) {
      return {
        status: 'failed',
        error: 'Invalid permission auto-accept response',
        httpStatus: response.status,
      };
    }
    return { status: 'ok', sessions };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function setLynxSessionPermissionAutoAccept(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    sessionId: string;
    enabled: boolean;
    directory?: string | null;
  },
): Promise<LynxPermissionAutoAcceptSnapshotResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { status: 'failed', error: 'sessionId required', httpStatus: 0 };
  }
  try {
    const body: { enabled: boolean; directory?: string } = { enabled: input.enabled };
    const directory = input.directory?.trim();
    if (directory) body.directory = directory;
    const response = await runtimeFetch(
      `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `permission-auto-accept PUT failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    const sessions = parseSnapshot(payload);
    if (!sessions) {
      return {
        status: 'failed',
        error: 'Invalid permission auto-accept response',
        httpStatus: response.status,
      };
    }
    return { status: 'ok', sessions };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

/** Cap togglePermissionAutoAccept. */
export const toggleLynxPermissionAutoAccept = (args: LynxPermissionAutoAcceptToggleArgs): void => {
  const {
    permissionScopeSessionId,
    newSessionDraftOpen,
    draftPermissionAutoAcceptEnabled,
    permissionAutoAcceptEnabled,
    setDraftPermissionAutoAcceptEnabled,
    setSessionAutoAccept,
    onOpenSessionFirst,
    onToggleFailed,
  } = args;

  if (!permissionScopeSessionId) {
    if (!newSessionDraftOpen) {
      onOpenSessionFirst();
      return;
    }
    setDraftPermissionAutoAcceptEnabled(!draftPermissionAutoAcceptEnabled);
    return;
  }

  const nextEnabled = !permissionAutoAcceptEnabled;
  void setSessionAutoAccept(permissionScopeSessionId, nextEnabled).catch(onToggleFailed);
};

/**
 * Cap VSCode / client auto-reply: when policy says accept, reply `once`.
 * Failed replies stay in the returned list for manual action (never fake-success).
 */
export async function autoReplyLynxPermissionsWhenEnabled(input: {
  runtimeFetch: LynxRuntimeFetch | null | undefined;
  permissions: readonly LynxPermissionRequest[];
  autoAccept: LynxPermissionAutoAcceptMap;
  sessions: readonly LynxSessionLineageNode[];
  directory?: string | null;
  reply?: LynxPermissionReply;
}): Promise<{
  remaining: LynxPermissionRequest[];
  acceptedIds: string[];
  failures: Array<{ id: string; error: string }>;
}> {
  const reply = input.reply ?? 'once';
  const remaining: LynxPermissionRequest[] = [];
  const acceptedIds: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const permission of input.permissions) {
    const enabled = lynxAutoRespondsPermission({
      autoAccept: input.autoAccept,
      sessions: input.sessions,
      sessionID: permission.sessionID,
    });
    if (!enabled) {
      remaining.push(permission);
      continue;
    }
    const result = await replyLynxPermission(input.runtimeFetch, {
      requestId: permission.id,
      reply,
      directory: input.directory,
    });
    if (result.status === 'ok') {
      acceptedIds.push(permission.id);
    } else {
      remaining.push(permission);
      failures.push({
        id: permission.id,
        error: result.status === 'no-runtime' ? 'no-runtime' : result.error,
      });
    }
  }

  return { remaining, acceptedIds, failures };
}
