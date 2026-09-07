/**
 * Cap `/api/openchamber/message-queue` thin portable client for Lynx.
 *
 * Ports list/admit/reorder/remove/send-now (+ flush = send-now first) over
 * LynxRuntimeFetch — no Zustand / TanStack / @dnd-kit. Honest parse; HTTP /
 * no-runtime never fake-success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxHttpResponse, LynxRequestInit } from '../connection/types';

export const LYNX_MESSAGE_QUEUE_ROUTE = '/api/openchamber/message-queue';

export type LynxMessageQueueServerErrorCode =
  | 'validation_error'
  | 'revision_conflict'
  | 'row_version_conflict'
  | 'idempotency_conflict'
  | 'generation_conflict'
  | 'authority_conflict'
  | 'not_found'
  | 'scope_locked'
  | 'scope_limit'
  | 'reserved'
  | 'internal_error'
  | 'unavailable';

export class LynxMessageQueueServerError extends Error {
  readonly status: number;
  readonly code: LynxMessageQueueServerErrorCode;

  constructor(status: number, code: LynxMessageQueueServerErrorCode) {
    super(`Message queue server request failed: ${code}`);
    this.name = 'LynxMessageQueueServerError';
    this.status = status;
    this.code = code;
  }
}

export type LynxMessageQueueItem = {
  queueItemID: string;
  operationID: string;
  messageID: string;
  content: string;
  status: string;
  attemptCount: number;
  position: number;
  rowVersion: number;
  createdAt: number;
  manualDispatchRequested?: boolean;
};

export type LynxMessageQueueScope = {
  scopeID: string;
  revision: number;
  directory: string;
  sessionID: string;
  worktreeState: string;
  items: LynxMessageQueueItem[];
  itemCount: number;
  nextOffset?: number;
};

export type LynxMessageQueueScopeDescriptor = {
  scopeID: string;
  revision: number;
  directory: string;
  sessionID: string;
  worktreeState: string;
  itemCount: number;
};

export type LynxMessageQueueSnapshot = {
  revision: number;
  scopes: LynxMessageQueueScopeDescriptor[];
};

export type LynxMessageQueueMutationResult = {
  revision: number;
  scopeID?: string;
  queueItemID?: string;
  rowVersion?: number;
  removedQueueItemID?: string;
};

export type LynxMessageQueueAdmissionItem = {
  queueItemID: string;
  operationID: string;
  messageID: string;
  content: string;
  attachments: [];
  attachmentIssues: [];
  createdAt: number;
  sendConfig?: {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
  };
};

export type LynxMessageQueueResult<T> =
  | { status: 'ok'; value: T }
  | {
    status: 'failed';
    error: string;
    reason: 'no-runtime' | 'http' | 'unavailable' | 'invalid';
    code?: LynxMessageQueueServerErrorCode;
    httpStatus?: number;
  };

const ERROR_CODES = new Set<LynxMessageQueueServerErrorCode>([
  'validation_error',
  'revision_conflict',
  'row_version_conflict',
  'idempotency_conflict',
  'generation_conflict',
  'authority_conflict',
  'not_found',
  'scope_locked',
  'scope_limit',
  'reserved',
  'internal_error',
  'unavailable',
]);

const MUTATION_KEYS = new Set([
  'revision',
  'scopeID',
  'queueItemID',
  'rowVersion',
  'removedQueueItemID',
  'projectDirectory',
  'token',
  'state',
  'scopeCount',
  'statusCounts',
]);

const SCOPE_DESCRIPTOR_KEYS = new Set([
  'scopeID',
  'revision',
  'directory',
  'sessionID',
  'worktreeState',
  'itemCount',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const joinQuery = (params: Record<string, string | number | undefined>): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

const parseErrorCode = async (
  response: LynxHttpResponse,
): Promise<LynxMessageQueueServerErrorCode> => {
  if (response.status === 501) return 'unavailable';
  try {
    const payload: unknown = await response.json();
    if (
      isRecord(payload)
      && typeof payload.code === 'string'
      && ERROR_CODES.has(payload.code as LynxMessageQueueServerErrorCode)
    ) {
      return payload.code as LynxMessageQueueServerErrorCode;
    }
  } catch {
    // Stable errors deliberately omit untrusted response content.
  }
  return 'unavailable';
};

const toFailed = (
  error: unknown,
): Extract<LynxMessageQueueResult<never>, { status: 'failed' }> => {
  if (error instanceof LynxMessageQueueServerError) {
    const reason = error.code === 'unavailable' && (error.status === 0 || error.status === 501)
      ? 'unavailable'
      : error.code === 'unavailable'
        ? 'unavailable'
        : 'http';
    return {
      status: 'failed',
      error: error.message,
      reason,
      code: error.code,
      httpStatus: error.status,
    };
  }
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : 'message-queue request failed',
    reason: 'http',
  };
};

const requestJson = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  path: string,
  init?: LynxRequestInit,
): Promise<unknown> => {
  if (!runtimeFetch) {
    throw new LynxMessageQueueServerError(0, 'unavailable');
  }
  let response: LynxHttpResponse;
  try {
    response = await runtimeFetch(path, init);
  } catch {
    throw new LynxMessageQueueServerError(0, 'unavailable');
  }
  if (response.status === 0 && !response.ok) {
    throw new LynxMessageQueueServerError(0, 'unavailable');
  }
  if (!response.ok) {
    throw new LynxMessageQueueServerError(response.status, await parseErrorCode(response));
  }
  try {
    return await response.json();
  } catch {
    throw new LynxMessageQueueServerError(response.status, 'unavailable');
  }
};

const malformed = (): never => {
  throw new LynxMessageQueueServerError(200, 'unavailable');
};

const parseItem = (value: unknown): LynxMessageQueueItem | null => {
  if (
    !isRecord(value)
    || typeof value.queueItemID !== 'string'
    || typeof value.operationID !== 'string'
    || typeof value.messageID !== 'string'
    || typeof value.content !== 'string'
    || typeof value.status !== 'string'
    || !isRevision(value.attemptCount)
    || !isRevision(value.position)
    || !isRevision(value.rowVersion)
    || !isRevision(value.createdAt)
  ) {
    return null;
  }
  if (value.manualDispatchRequested !== undefined && typeof value.manualDispatchRequested !== 'boolean') {
    return null;
  }
  return {
    queueItemID: value.queueItemID,
    operationID: value.operationID,
    messageID: value.messageID,
    content: value.content,
    status: value.status,
    attemptCount: value.attemptCount,
    position: value.position,
    rowVersion: value.rowVersion,
    createdAt: value.createdAt,
    ...(value.manualDispatchRequested === true ? { manualDispatchRequested: true } : {}),
  };
};

const parseScope = (value: unknown): LynxMessageQueueScope | null => {
  if (
    !isRecord(value)
    || typeof value.scopeID !== 'string'
    || !isRevision(value.revision)
    || typeof value.directory !== 'string'
    || typeof value.sessionID !== 'string'
    || typeof value.worktreeState !== 'string'
    || !isRevision(value.itemCount)
    || !Array.isArray(value.items)
    || value.items.length > 8
    || (
      value.nextOffset !== undefined
      && (!isRevision(value.nextOffset) || value.nextOffset <= 0)
    )
  ) {
    return null;
  }
  const items = value.items.map(parseItem);
  if (!items.every((item): item is LynxMessageQueueItem => item !== null)) return null;
  return {
    scopeID: value.scopeID,
    revision: value.revision,
    directory: value.directory,
    sessionID: value.sessionID,
    worktreeState: value.worktreeState,
    itemCount: value.itemCount,
    items,
    ...(value.nextOffset === undefined ? {} : { nextOffset: value.nextOffset }),
  };
};

const parseScopeDescriptor = (value: unknown): LynxMessageQueueScopeDescriptor | null => (
  isRecord(value)
  && Object.keys(value).every((key) => SCOPE_DESCRIPTOR_KEYS.has(key))
  && typeof value.scopeID === 'string'
  && isRevision(value.revision)
  && typeof value.directory === 'string'
  && typeof value.sessionID === 'string'
  && typeof value.worktreeState === 'string'
  && isRevision(value.itemCount)
    ? {
      scopeID: value.scopeID,
      revision: value.revision,
      directory: value.directory,
      sessionID: value.sessionID,
      worktreeState: value.worktreeState,
      itemCount: value.itemCount,
    }
    : null
);

const parseSnapshot = (value: unknown): LynxMessageQueueSnapshot => {
  if (!isRecord(value) || !isRevision(value.revision) || !Array.isArray(value.scopes)) {
    return malformed();
  }
  const scopes = value.scopes.map(parseScopeDescriptor);
  if (!scopes.every((scope): scope is LynxMessageQueueScopeDescriptor => scope !== null)) {
    return malformed();
  }
  return { revision: value.revision, scopes };
};

const parseMutation = (value: unknown): LynxMessageQueueMutationResult => {
  if (!isRecord(value) || !isRevision(value.revision) || Object.keys(value).some((key) => !MUTATION_KEYS.has(key))) {
    return malformed();
  }
  if (
    (value.scopeID !== undefined && typeof value.scopeID !== 'string')
    || (value.queueItemID !== undefined && typeof value.queueItemID !== 'string')
    || (value.rowVersion !== undefined && !isRevision(value.rowVersion))
    || (value.removedQueueItemID !== undefined && typeof value.removedQueueItemID !== 'string')
  ) {
    return malformed();
  }
  return {
    revision: value.revision,
    ...(typeof value.scopeID === 'string' ? { scopeID: value.scopeID } : {}),
    ...(typeof value.queueItemID === 'string' ? { queueItemID: value.queueItemID } : {}),
    ...(isRevision(value.rowVersion) ? { rowVersion: value.rowVersion } : {}),
    ...(typeof value.removedQueueItemID === 'string'
      ? { removedQueueItemID: value.removedQueueItemID }
      : {}),
  };
};

const jsonInit = (method: string, body: object, signal?: AbortSignal): LynxRequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
});

const normalizeDirectory = (value: string): string => value.replace(/\/+$/, '') || '/';

/** Cap GET snapshot — scope descriptors for directory+session lookup. */
export async function fetchLynxMessageQueueSnapshot(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<LynxMessageQueueResult<LynxMessageQueueSnapshot>> {
  try {
    const value = parseSnapshot(await requestJson(runtimeFetch, LYNX_MESSAGE_QUEUE_ROUTE, {
      signal: options.signal,
    }));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/** Cap GET `/scopes/:scopeID` with offset/limit/expectedRevision. */
export async function fetchLynxMessageQueueScope(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  scopeID: string,
  options: {
    offset?: number;
    limit?: number;
    expectedRevision?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LynxMessageQueueResult<LynxMessageQueueScope>> {
  const id = scopeID.trim();
  if (!id) {
    return { status: 'failed', error: 'scope id required', reason: 'invalid' };
  }
  try {
    const query = joinQuery({
      offset: options.offset,
      limit: options.limit,
      expectedRevision: options.expectedRevision,
    });
    const value = parseScope(await requestJson(
      runtimeFetch,
      `${LYNX_MESSAGE_QUEUE_ROUTE}/scopes/${encodeURIComponent(id)}${query}`,
      { signal: options.signal },
    ));
    if (!value) return toFailed(new LynxMessageQueueServerError(200, 'unavailable'));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/**
 * List/get scope for a directory+session: snapshot → matching descriptor → scope page.
 * Empty ok when no scope yet (admit will create).
 */
export async function fetchLynxMessageQueueScopeForSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { directory: string; sessionID: string; signal?: AbortSignal },
): Promise<LynxMessageQueueResult<LynxMessageQueueScope | null>> {
  const sessionID = input.sessionID.trim();
  const directory = input.directory.trim();
  if (!sessionID) {
    return { status: 'failed', error: 'session id required', reason: 'invalid' };
  }
  const snapshot = await fetchLynxMessageQueueSnapshot(runtimeFetch, { signal: input.signal });
  if (snapshot.status !== 'ok') return snapshot;
  const dirKey = normalizeDirectory(directory || '/');
  const descriptor = snapshot.value.scopes.find((scope) => (
    scope.sessionID === sessionID
    && normalizeDirectory(scope.directory) === dirKey
  ));
  if (!descriptor) return { status: 'ok', value: null };
  return fetchLynxMessageQueueScope(runtimeFetch, descriptor.scopeID, {
    offset: 0,
    limit: 8,
    expectedRevision: descriptor.revision,
    signal: input.signal,
  });
}

/** Cap POST `/items` text admit. */
export async function admitLynxTextQueueItem(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    requestID: string;
    expectedRevision?: number;
    scope: { directory: string; sessionID: string };
    item: LynxMessageQueueAdmissionItem;
    signal?: AbortSignal;
  },
): Promise<LynxMessageQueueResult<LynxMessageQueueMutationResult>> {
  if (!input.requestID.trim() || !input.scope.sessionID.trim() || !input.item.content.trim()) {
    return { status: 'failed', error: 'admit requires requestID, sessionID, content', reason: 'invalid' };
  }
  try {
    const { signal, ...body } = input;
    const value = parseMutation(await requestJson(
      runtimeFetch,
      `${LYNX_MESSAGE_QUEUE_ROUTE}/items`,
      jsonInit('POST', body, signal),
    ));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/** Cap PUT `/scopes/:scopeID/order` — portable ↑/↓ via queueItemIDs. */
export async function reorderLynxQueueScope(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  scopeID: string,
  input: {
    requestID: string;
    expectedRevision: number;
    queueItemIDs: string[];
    signal?: AbortSignal;
  },
): Promise<LynxMessageQueueResult<LynxMessageQueueMutationResult>> {
  const id = scopeID.trim();
  if (!id || !input.requestID.trim() || !Array.isArray(input.queueItemIDs)) {
    return { status: 'failed', error: 'reorder requires scopeID, requestID, queueItemIDs', reason: 'invalid' };
  }
  try {
    const { signal, ...body } = input;
    const value = parseMutation(await requestJson(
      runtimeFetch,
      `${LYNX_MESSAGE_QUEUE_ROUTE}/scopes/${encodeURIComponent(id)}/order`,
      jsonInit('PUT', body, signal),
    ));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/** Cap DELETE `/items/:queueItemID`. */
export async function removeLynxQueueItem(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  queueItemID: string,
  input: {
    requestID: string;
    expectedRevision: number;
    expectedRowVersion: number;
    signal?: AbortSignal;
  },
): Promise<LynxMessageQueueResult<LynxMessageQueueMutationResult>> {
  const id = queueItemID.trim();
  if (!id || !input.requestID.trim()) {
    return { status: 'failed', error: 'remove requires queueItemID, requestID', reason: 'invalid' };
  }
  try {
    const { signal, ...body } = input;
    const value = parseMutation(await requestJson(
      runtimeFetch,
      `${LYNX_MESSAGE_QUEUE_ROUTE}/items/${encodeURIComponent(id)}`,
      jsonInit('DELETE', body, signal),
    ));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/** Cap POST `/items/:queueItemID/send` (manual send-now). */
export async function sendLynxQueueItemNow(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  queueItemID: string,
  input: {
    requestID: string;
    expectedRevision: number;
    expectedRowVersion: number;
    signal?: AbortSignal;
  },
): Promise<LynxMessageQueueResult<LynxMessageQueueMutationResult>> {
  const id = queueItemID.trim();
  if (!id || !input.requestID.trim()) {
    return { status: 'failed', error: 'send-now requires queueItemID, requestID', reason: 'invalid' };
  }
  try {
    const { signal, ...body } = input;
    const value = parseMutation(await requestJson(
      runtimeFetch,
      `${LYNX_MESSAGE_QUEUE_ROUTE}/items/${encodeURIComponent(id)}/send`,
      jsonInit('POST', body, signal),
    ));
    return { status: 'ok', value };
  } catch (error) {
    return toFailed(error);
  }
}

/** Flush maps to Cap send-now on the first queued item (no dedicated flush route). */
export async function flushLynxQueueScopeFirst(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  scope: LynxMessageQueueScope,
  input: { requestID: string; signal?: AbortSignal },
): Promise<LynxMessageQueueResult<LynxMessageQueueMutationResult>> {
  const first = scope.items[0];
  if (!first) {
    return { status: 'failed', error: 'queue empty', reason: 'invalid' };
  }
  return sendLynxQueueItemNow(runtimeFetch, first.queueItemID, {
    requestID: input.requestID,
    expectedRevision: scope.revision,
    expectedRowVersion: first.rowVersion,
    signal: input.signal,
  });
}

export function lynxQueueItemsToPrompts(
  items: readonly LynxMessageQueueItem[],
): Array<{ id: string; text: string; createdAt: number; rowVersion: number }> {
  return items.map((item) => ({
    id: item.queueItemID,
    text: item.content,
    createdAt: item.createdAt,
    rowVersion: item.rowVersion,
  }));
}

export function isLynxMessageQueueUnavailable(
  result: Extract<LynxMessageQueueResult<unknown>, { status: 'failed' }>,
): boolean {
  return result.reason === 'unavailable'
    || result.code === 'unavailable'
    || result.httpStatus === 501
    || result.httpStatus === 0;
}
