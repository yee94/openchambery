/**
 * Minimal Cap message-queue server client for Expo Chat queue chips.
 * Endpoints: GET /api/openchamber/message-queue (+ /scopes/:id), POST /items, DELETE /items/:id.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type MessageQueueChipItem = {
  queueItemID: string;
  content: string;
  status: string;
  position: number;
  rowVersion: number;
  createdAt: number;
};

export type MessageQueueScopeSummary = {
  scopeID: string;
  revision: number;
  directory: string;
  sessionID: string;
  items: MessageQueueChipItem[];
};

export class MessageQueueApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null = null, code = 'unavailable') {
    super(message);
    this.name = 'MessageQueueApiError';
    this.status = status;
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const parseItem = (value: unknown): MessageQueueChipItem | null => {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.queueItemID !== 'string' || typeof row.content !== 'string') return null;
  if (typeof row.status !== 'string') return null;
  return {
    queueItemID: row.queueItemID,
    content: row.content,
    status: row.status,
    position: typeof row.position === 'number' ? row.position : 0,
    rowVersion: typeof row.rowVersion === 'number' ? row.rowVersion : 0,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
  };
};

export const parseQueueSnapshotScopes = (
  payload: unknown,
): Array<{ scopeID: string; revision: number; directory: string; sessionID: string; itemCount: number }> => {
  const body = asRecord(payload);
  if (!body || !Array.isArray(body.scopes)) return [];
  return body.scopes.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.scopeID !== 'string' || typeof row.sessionID !== 'string') return [];
    return [
      {
        scopeID: row.scopeID,
        revision: typeof row.revision === 'number' ? row.revision : 0,
        directory: typeof row.directory === 'string' ? row.directory : '',
        sessionID: row.sessionID,
        itemCount: typeof row.itemCount === 'number' ? row.itemCount : 0,
      },
    ];
  });
};

export const parseQueueScope = (payload: unknown): MessageQueueScopeSummary | null => {
  const body = asRecord(payload);
  if (!body || typeof body.scopeID !== 'string' || typeof body.sessionID !== 'string') return null;
  const items = Array.isArray(body.items)
    ? body.items.map(parseItem).filter((item): item is MessageQueueChipItem => item != null)
    : [];
  return {
    scopeID: body.scopeID,
    revision: typeof body.revision === 'number' ? body.revision : 0,
    directory: typeof body.directory === 'string' ? body.directory : '',
    sessionID: body.sessionID,
    items,
  };
};

export const previewQueueContent = (content: string): string => {
  const line = content.split('\n')[0]?.trim() ?? '';
  if (line.length <= 80) return line;
  return `${line.slice(0, 80)}…`;
};

/** GET /api/openchamber/message-queue — find scope for session, then page items. */
export const loadSessionQueueChips = async (
  active: ActiveRuntime,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<MessageQueueScopeSummary | null> => {
  const sessionID = sessionId.trim();
  if (!sessionID) return null;

  let snapshotResponse;
  try {
    snapshotResponse = await openchamberFetch(active, '/api/openchamber/message-queue', {
      method: 'GET',
      signal: options?.signal,
    });
  } catch (error) {
    throw new MessageQueueApiError(
      error instanceof Error ? error.message : 'message-queue snapshot failed',
      null,
    );
  }

  if (snapshotResponse.status === 501 || snapshotResponse.status === 404) return null;
  if (!snapshotResponse.ok) {
    throw new MessageQueueApiError(
      `message-queue snapshot failed (${snapshotResponse.status})`,
      snapshotResponse.status,
    );
  }

  const scopes = parseQueueSnapshotScopes(await snapshotResponse.json());
  const match = scopes.find((scope) => scope.sessionID === sessionID);
  if (!match) {
    return {
      scopeID: '',
      revision: 0,
      directory: '',
      sessionID,
      items: [],
    };
  }
  if (match.itemCount === 0) {
    return {
      scopeID: match.scopeID,
      revision: match.revision,
      directory: match.directory,
      sessionID: match.sessionID,
      items: [],
    };
  }

  const scopeResponse = await openchamberFetch(
    active,
    `/api/openchamber/message-queue/scopes/${encodeURIComponent(match.scopeID)}`,
    { method: 'GET', signal: options?.signal },
  );
  if (!scopeResponse.ok) {
    throw new MessageQueueApiError(
      `message-queue scope failed (${scopeResponse.status})`,
      scopeResponse.status,
    );
  }
  return parseQueueScope(await scopeResponse.json());
};

export type AdmitQueueItemInput = {
  sessionID: string;
  directory: string;
  content: string;
  requestID: string;
  queueItemID: string;
  operationID: string;
  messageID: string;
  expectedRevision?: number;
};

/** POST /api/openchamber/message-queue/items — Cap admitTextQueueItem subset. */
export const admitTextQueueItem = async (
  active: ActiveRuntime,
  input: AdmitQueueItemInput,
  options?: { signal?: AbortSignal },
): Promise<{ revision: number }> => {
  const body = {
    requestID: input.requestID,
    ...(typeof input.expectedRevision === 'number'
      ? { expectedRevision: input.expectedRevision }
      : {}),
    scope: {
      directory: input.directory,
      sessionID: input.sessionID,
    },
    item: {
      queueItemID: input.queueItemID,
      operationID: input.operationID,
      messageID: input.messageID,
      content: input.content,
      attachments: [],
      attachmentIssues: [],
      createdAt: Date.now(),
    },
  };

  const response = await openchamberFetch(active, '/api/openchamber/message-queue/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new MessageQueueApiError(
      `message-queue admit failed (${response.status})`,
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return { revision: typeof payload?.revision === 'number' ? payload.revision : 0 };
};

/** DELETE /api/openchamber/message-queue/items/:id */
export const removeQueueItem = async (
  active: ActiveRuntime,
  input: {
    queueItemID: string;
    requestID: string;
    expectedRevision: number;
    expectedRowVersion: number;
  },
  options?: { signal?: AbortSignal },
): Promise<void> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/message-queue/items/${encodeURIComponent(input.queueItemID)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        requestID: input.requestID,
        expectedRevision: input.expectedRevision,
        expectedRowVersion: input.expectedRowVersion,
      }),
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    throw new MessageQueueApiError(
      `message-queue remove failed (${response.status})`,
      response.status,
    );
  }
};

export type ReorderQueueScopeInput = {
  scopeID: string;
  requestID: string;
  expectedRevision: number;
  queueItemIDs: string[];
};

/** PUT /api/openchamber/message-queue/scopes/:id/order — Cap reorder without DnD. */
export const reorderQueueScope = async (
  active: ActiveRuntime,
  input: ReorderQueueScopeInput,
  options?: { signal?: AbortSignal },
): Promise<{ revision: number }> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/message-queue/scopes/${encodeURIComponent(input.scopeID)}/order`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        requestID: input.requestID,
        expectedRevision: input.expectedRevision,
        queueItemIDs: input.queueItemIDs,
      }),
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    throw new MessageQueueApiError(
      `message-queue reorder failed (${response.status})`,
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return { revision: typeof payload?.revision === 'number' ? payload.revision : 0 };
};

export type EditQueueItemInput = {
  queueItemID: string;
  requestID: string;
  expectedRevision: number;
  expectedRowVersion: number;
  content: string;
};

/** PATCH /api/openchamber/message-queue/items/:id — Cap editTextQueueItem content subset. */
export const editQueueItemContent = async (
  active: ActiveRuntime,
  input: EditQueueItemInput,
  options?: { signal?: AbortSignal },
): Promise<{ revision: number }> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/message-queue/items/${encodeURIComponent(input.queueItemID)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        requestID: input.requestID,
        expectedRevision: input.expectedRevision,
        expectedRowVersion: input.expectedRowVersion,
        item: { content: input.content },
      }),
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    throw new MessageQueueApiError(
      `message-queue edit failed (${response.status})`,
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  return { revision: typeof payload?.revision === 'number' ? payload.revision : 0 };
};

