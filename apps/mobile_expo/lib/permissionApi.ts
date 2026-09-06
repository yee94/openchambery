/**
 * Minimal Cap permission client for Expo Chat PermissionCard.
 * Contracts: GET /api/permission?directory=…, POST /api/permission/:id/reply
 * Event types: permission.asked / permission.replied / permission.rejected
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type PermissionResponse = 'once' | 'always' | 'reject';

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

export class PermissionApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null = null, code = 'unavailable') {
    super(message);
    this.name = 'PermissionApiError';
    this.status = status;
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parsePermissionRequest = (value: unknown): PermissionRequest | null => {
  const row = asRecord(value);
  if (!row || typeof row.id !== 'string' || typeof row.sessionID !== 'string') return null;
  const patterns = Array.isArray(row.patterns)
    ? row.patterns.filter((p): p is string => typeof p === 'string')
    : [];
  const always = Array.isArray(row.always)
    ? row.always.filter((p): p is string => typeof p === 'string')
    : [];
  const metadata = asRecord(row.metadata) ?? {};
  const toolRow = asRecord(row.tool);
  const tool =
    toolRow && typeof toolRow.messageID === 'string' && typeof toolRow.callID === 'string'
      ? { messageID: toolRow.messageID, callID: toolRow.callID }
      : undefined;
  return {
    id: row.id,
    sessionID: row.sessionID,
    permission: typeof row.permission === 'string' ? row.permission : 'unknown',
    patterns,
    metadata,
    always,
    ...(tool ? { tool } : {}),
  };
};

export const parsePermissionList = (payload: unknown): PermissionRequest[] => {
  if (Array.isArray(payload)) {
    return payload.map(parsePermissionRequest).filter((p): p is PermissionRequest => p != null);
  }
  const body = asRecord(payload);
  if (body && Array.isArray(body.data)) {
    return body.data.map(parsePermissionRequest).filter((p): p is PermissionRequest => p != null);
  }
  return [];
};

const withDirectory = (path: string, directory?: string | null): string => {
  if (!directory?.trim()) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}directory=${encodeURIComponent(directory.trim())}`;
};

export async function listPendingPermissions(
  active: ActiveRuntime,
  options?: { directory?: string | null; sessionId?: string | null },
): Promise<PermissionRequest[]> {
  const path = withDirectory('/api/permission', options?.directory);
  const response = await openchamberFetch(active, path, { method: 'GET' });
  if (!response.ok) {
    throw new PermissionApiError(
      `permission.list failed (${response.status})`,
      response.status,
      'list_failed',
    );
  }
  const payload = await response.json();
  const all = parsePermissionList(payload);
  const sessionId = options?.sessionId?.trim();
  if (!sessionId) return all;
  return all.filter((p) => p.sessionID === sessionId);
}

export async function replyToPermission(
  active: ActiveRuntime,
  input: {
    requestId: string;
    reply: PermissionResponse;
    directory?: string | null;
  },
): Promise<void> {
  const path = withDirectory(
    `/api/permission/${encodeURIComponent(input.requestId)}/reply`,
    input.directory,
  );
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply: input.reply }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const notFound = response.status === 404 || /not\s*found/i.test(text);
    throw new PermissionApiError(
      notFound ? 'permission no longer pending' : `permission.reply failed (${response.status})`,
      response.status,
      notFound ? 'not_found' : 'reply_failed',
    );
  }
}

export const isPermissionNotFoundError = (err: unknown): boolean =>
  err instanceof PermissionApiError && err.code === 'not_found';

/** Apply Cap permission.* events onto a pending list for one session. */
export function applyPermissionEvent(
  pending: PermissionRequest[],
  event: { type: string; properties?: Record<string, unknown> },
  sessionId: string,
): PermissionRequest[] {
  if (event.type === 'permission.asked') {
    const next = parsePermissionRequest(event.properties);
    if (!next || next.sessionID !== sessionId) return pending;
    const index = pending.findIndex((p) => p.id === next.id);
    if (index < 0) return [...pending, next];
    const copy = pending.slice();
    copy[index] = next;
    return copy;
  }
  if (event.type === 'permission.replied' || event.type === 'permission.rejected') {
    const props = event.properties ?? {};
    const requestID =
      typeof props.requestID === 'string'
        ? props.requestID
        : typeof props.id === 'string'
          ? props.id
          : null;
    const sid = typeof props.sessionID === 'string' ? props.sessionID : null;
    if (!requestID) return pending;
    if (sid && sid !== sessionId) return pending;
    return pending.filter((p) => p.id !== requestID);
  }
  return pending;
}

/** Cap PermissionCard metadata helpers (pure). */
export const permissionMetaString = (
  metadata: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const val = metadata[key];
    if (typeof val === 'string' && val.trim()) return val;
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return '';
};

export const permissionDisplayToolName = (toolName: string): string => {
  const tool = toolName.toLowerCase();
  if (
    tool === 'edit' ||
    tool === 'multiedit' ||
    tool === 'str_replace' ||
    tool === 'str_replace_based_edit_tool'
  ) {
    return 'edit';
  }
  if (tool === 'write' || tool === 'create' || tool === 'file_write') return 'write';
  if (
    tool === 'bash' ||
    tool === 'shell' ||
    tool === 'cmd' ||
    tool === 'terminal' ||
    tool === 'shell_command'
  ) {
    return 'bash';
  }
  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return 'webfetch';
  }
  return toolName;
};
