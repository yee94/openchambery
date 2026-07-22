import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';

export type MessageQueueComposerReference = Record<string, unknown>;
export type MessageQueueComposerDocument = { text: string; references: MessageQueueComposerReference[] };
export type MessageQueueComposerMention = Record<string, unknown>;
export type MessageQueueAttachmentIssue = Record<string, unknown>;

export type MessageQueueSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};
export type MessageQueueDeliveryTarget = { kind: 'primary' } | { kind: 'assistant'; assistantID: string };
export type MessageQueueDeliveryPart = { type: 'text'; text: string } | { type: 'file'; mime: string; attachmentID: string } | { type: 'file'; mime: string; url: string };
export type MessageQueueSyntheticPart = { partID: string; text: string; synthetic?: boolean; attachmentIDs: string[]; deliveryPartIndexes: number[] };

export type MessageQueueAttachment = {
  attachmentID: string;
  occurrenceRefID: readonly ["root", string] | readonly ["part", string, string];
  filename: string;
  mimeType: string;
  size: number;
  source: "local" | "vscode" | "server";
  locator: { kind: "upload"; uploadID: string } | { kind: "server-path"; path: string };
}

export type MessageQueueAdmissionItem = {
  queueItemID: string;
  operationID: string;
  messageID: string;
  content: string;
  composerDocument?: MessageQueueComposerDocument;
  composerMentions?: MessageQueueComposerMention[];
  sendConfig?: MessageQueueSendConfig;
  deliveryTarget?: MessageQueueDeliveryTarget;
  /** Assistant queue items retain their fully compiled send payload. */
  deliveryParts?: MessageQueueDeliveryPart[];
  syntheticParts?: MessageQueueSyntheticPart[];
  attachments: MessageQueueAttachment[];
  attachmentIssues: MessageQueueAttachmentIssue[];
  createdAt: number;
  migrationImport?: boolean;
  migrationState?: { status: 'queued' | 'retrying' | 'reconciling' | 'unresolved' | 'failed' | 'sending'; attemptCount?: number; dueAt?: number; reconciliationStartedAt?: number; reconciliationDeadlineAt?: number; reconciliationChecks?: number; reconciliationNextCheckAt?: number; failureKind?: string };
};

export type MessageQueueItem = {
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
  composerDocument?: MessageQueueComposerDocument;
  composerMentions?: MessageQueueComposerMention[];
  sendConfig?: MessageQueueSendConfig;
  deliveryTarget?: MessageQueueDeliveryTarget;
  deliveryParts?: MessageQueueDeliveryPart[];
  syntheticParts?: MessageQueueSyntheticPart[];
  attachments?: MessageQueueAttachment[];
  attachmentIssues?: MessageQueueAttachmentIssue[];
};

export type MessageQueueScope = {
  scopeID: string;
  revision: number;
  directory: string;
  sessionID: string;
  worktreeState: string;
  items: MessageQueueItem[];
  itemCount: number;
  nextOffset?: number;
};

export type WorktreeOrder = {
  projectDirectory: string;
  orderedPaths: string[];
  revision: number;
};

export type MessageQueueSnapshot = {
  revision: number;
  scopes: MessageQueueScopeDescriptor[];
  worktreeOrders: WorktreeOrder[];
};

export type MessageQueueScopeDescriptor = {
  scopeID: string;
  revision: number;
  directory: string;
  sessionID: string;
  worktreeState: string;
  itemCount: number;
};

type MessageQueueMutationResult = {
  revision: number;
  scopeID?: string;
  queueItemID?: string;
  rowVersion?: number;
  removedQueueItemID?: string;
  projectDirectory?: string;
  token?: string;
  state?: string;
  scopeCount?: number;
  statusCounts?: Record<string, number>;
};

export type MessageQueueServerErrorCode =
  | 'validation_error'
  | 'revision_conflict'
  | 'row_version_conflict'
  | 'idempotency_conflict'
  | 'generation_conflict'
  | 'authority_conflict'
  | 'not_found'
  | 'scope_locked'
  | 'reserved'
  | 'internal_error'
  | 'unavailable';

export class MessageQueueServerError extends Error {
  readonly status: number;
  readonly code: MessageQueueServerErrorCode;

  constructor(status: number, code: MessageQueueServerErrorCode) {
    super(`Message queue server request failed: ${code}`);
    this.name = 'MessageQueueServerError';
    this.status = status;
    this.code = code;
  }
}

const ROUTE = '/api/openchamber/message-queue';
const errorCodes = new Set<MessageQueueServerErrorCode>(['validation_error', 'revision_conflict', 'row_version_conflict', 'idempotency_conflict', 'generation_conflict', 'authority_conflict', 'not_found', 'scope_locked', 'reserved', 'internal_error', 'unavailable']);
const mutationKeys = new Set(['revision', 'scopeID', 'queueItemID', 'rowVersion', 'removedQueueItemID', 'projectDirectory', 'token', 'state', 'scopeCount', 'statusCounts']);
const scopeDescriptorKeys = new Set(['scopeID', 'revision', 'directory', 'sessionID', 'worktreeState', 'itemCount']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const parseErrorCode = async (response: Response): Promise<MessageQueueServerErrorCode> => {
  if (response.status === 501) return 'unavailable';
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.code === 'string' && errorCodes.has(payload.code as MessageQueueServerErrorCode)) return payload.code as MessageQueueServerErrorCode;
  } catch {
    // Stable errors deliberately omit untrusted response content.
  }
  return 'unavailable';
};

const request = async (path: string, init?: Parameters<typeof runtimeFetch>[1]): Promise<unknown> => {
  let response: Response;
  try {
    response = await runtimeFetch(path, init);
  } catch {
    throw new MessageQueueServerError(0, 'unavailable');
  }
  if (!response.ok) throw new MessageQueueServerError(response.status, await parseErrorCode(response));
  try {
    return await response.json();
  } catch {
    throw new MessageQueueServerError(response.status, 'unavailable');
  }
};

const malformed = (): never => { throw new MessageQueueServerError(200, 'unavailable'); };

const plainObject = (value: unknown): value is Record<string, unknown> => isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
const parseComposerDocument = (value: unknown): MessageQueueComposerDocument | undefined => {
  if (!plainObject(value) || typeof value.text !== 'string' || !Array.isArray(value.references) || value.references.some((reference) => !plainObject(reference))) return undefined;
  return { text: value.text, references: value.references.map((reference) => ({ ...reference })) };
};
const parseObjectArray = <T extends Record<string, unknown>>(value: unknown): T[] | undefined => Array.isArray(value) && value.every(plainObject) ? value.map((entry) => ({ ...entry } as T)) : undefined;

const parseSendConfig = (value: unknown): MessageQueueSendConfig | undefined => {
  if (!isRecord(value) || typeof value.providerID !== 'string' || typeof value.modelID !== 'string') return undefined;
  if ((value.agent !== undefined && typeof value.agent !== 'string') || (value.variant !== undefined && typeof value.variant !== 'string')) return undefined;
  return { providerID: value.providerID, modelID: value.modelID, ...(value.agent === undefined ? {} : { agent: value.agent }), ...(value.variant === undefined ? {} : { variant: value.variant }) };
};
const parseDeliveryTarget = (value: unknown): MessageQueueDeliveryTarget | null => {
  if (!isRecord(value)) return null;
  if (value.kind === 'primary' && Object.keys(value).length === 1) return { kind: 'primary' };
  if (value.kind === 'assistant' && Object.keys(value).every((key) => key === 'kind' || key === 'assistantID') && typeof value.assistantID === 'string' && value.assistantID) return { kind: 'assistant', assistantID: value.assistantID };
  return null;
};
const parseDeliveryParts = (value: unknown): MessageQueueDeliveryPart[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 129) return null;
  const parts: MessageQueueDeliveryPart[] = [];
  let files = 0;
  for (const part of value) {
    if (!plainObject(part)) return null;
    if (part.type === 'text' && Object.keys(part).length === 2 && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'file' && Object.keys(part).length === 3 && typeof part.mime === 'string' && typeof part.attachmentID === 'string' && part.attachmentID) {
      files += 1;
      if (files > 64) return null;
      parts.push({ type: 'file', mime: part.mime, attachmentID: part.attachmentID });
      continue;
    }
    if (part.type === 'file' && Object.keys(part).length === 3 && typeof part.mime === 'string' && typeof part.url === 'string') {
      files += 1;
      if (files > 64) return null;
      parts.push({ type: 'file', mime: part.mime, url: part.url });
      continue;
    }
    return null;
  }
  return parts;
};
const parseSyntheticParts = (value: unknown): MessageQueueSyntheticPart[] | null => {
  if (!Array.isArray(value) || value.length > 64) return null;
  const seen = new Set<string>();
  const parts: MessageQueueSyntheticPart[] = [];
  for (const part of value) {
    if (!plainObject(part) || Object.keys(part).some((key) => !['partID', 'text', 'synthetic', 'attachmentIDs', 'deliveryPartIndexes'].includes(key)) || typeof part.partID !== 'string' || !part.partID || seen.has(part.partID) || typeof part.text !== 'string' || (part.synthetic !== undefined && typeof part.synthetic !== 'boolean') || !Array.isArray(part.attachmentIDs) || part.attachmentIDs.some((id) => typeof id !== 'string' || !id) || new Set(part.attachmentIDs).size !== part.attachmentIDs.length || !Array.isArray(part.deliveryPartIndexes) || part.deliveryPartIndexes.length !== part.attachmentIDs.length + 1 || part.deliveryPartIndexes.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(part.deliveryPartIndexes).size !== part.deliveryPartIndexes.length) return null;
    seen.add(part.partID);
    parts.push({ partID: part.partID, text: part.text, ...(part.synthetic === true ? { synthetic: true } : {}), attachmentIDs: [...part.attachmentIDs], deliveryPartIndexes: [...part.deliveryPartIndexes] });
  }
  return parts;
};

const parseAttachment = (value: unknown): MessageQueueAttachment | null => {
  if (!plainObject(value) || Object.keys(value).some((key) => !['attachmentID', 'occurrenceRefID', 'filename', 'mimeType', 'size', 'source', 'locator'].includes(key)) || typeof value.attachmentID !== 'string' || !value.attachmentID || typeof value.filename !== 'string' || !value.filename || typeof value.mimeType !== 'string' || !value.mimeType || !isRevision(value.size) || !['local', 'vscode', 'server'].includes(String(value.source)) || !plainObject(value.locator)) return null;
  const occurrence = value.occurrenceRefID;
  const validOccurrence = Array.isArray(occurrence) && ((occurrence.length === 2 && occurrence[0] === 'root' && occurrence[1] === value.attachmentID) || (occurrence.length === 3 && occurrence[0] === 'part' && typeof occurrence[1] === 'string' && occurrence[1] && occurrence[2] === value.attachmentID));
  if (!validOccurrence) return null;
  const locator = value.locator;
  if (locator.kind === 'upload' && Object.keys(locator).every((key) => ['kind', 'uploadID', 'storageKey'].includes(key)) && typeof locator.uploadID === 'string' && locator.uploadID && (locator.storageKey === undefined || typeof locator.storageKey === 'string') && locator.storageKey !== '') return { attachmentID: value.attachmentID, occurrenceRefID: occurrence as unknown as MessageQueueAttachment['occurrenceRefID'], filename: value.filename, mimeType: value.mimeType, size: value.size, source: value.source as MessageQueueAttachment['source'], locator: { kind: 'upload', uploadID: locator.uploadID } };
  if (locator.kind === 'server-path' && Object.keys(locator).every((key) => ['kind', 'path'].includes(key)) && typeof locator.path === 'string' && locator.path) return { attachmentID: value.attachmentID, occurrenceRefID: occurrence as unknown as MessageQueueAttachment['occurrenceRefID'], filename: value.filename, mimeType: value.mimeType, size: value.size, source: value.source as MessageQueueAttachment['source'], locator: { kind: 'server-path', path: locator.path } };
  return null;
};
const parseAttachments = (value: unknown): MessageQueueAttachment[] | null => Array.isArray(value) ? value.map(parseAttachment).every((entry): entry is MessageQueueAttachment => entry !== null) ? value.map(parseAttachment) as MessageQueueAttachment[] : null : null;
const parseItem = (value: unknown): MessageQueueItem | null => {
  if (!isRecord(value) || typeof value.queueItemID !== 'string' || typeof value.operationID !== 'string' || typeof value.messageID !== 'string' || typeof value.content !== 'string' || typeof value.status !== 'string' || !isRevision(value.attemptCount) || !isRevision(value.position) || !isRevision(value.rowVersion) || !isRevision(value.createdAt)) return null;
  if (value.manualDispatchRequested !== undefined && typeof value.manualDispatchRequested !== 'boolean') return null;
  const composerDocument = value.composerDocument === undefined ? undefined : parseComposerDocument(value.composerDocument);
  const composerMentions = value.composerMentions === undefined ? undefined : parseObjectArray<MessageQueueComposerMention>(value.composerMentions);
  const sendConfig = value.sendConfig === undefined ? undefined : parseSendConfig(value.sendConfig);
  const deliveryTarget = value.deliveryTarget === undefined ? { kind: 'primary' } as const : parseDeliveryTarget(value.deliveryTarget);
  const deliveryParts = value.deliveryParts === undefined ? undefined : parseDeliveryParts(value.deliveryParts);
  const syntheticParts = value.syntheticParts === undefined ? undefined : parseSyntheticParts(value.syntheticParts);
  const attachmentIssues = value.attachmentIssues === undefined ? undefined : parseObjectArray<MessageQueueAttachmentIssue>(value.attachmentIssues);
  if ((value.composerDocument !== undefined && !composerDocument) || (value.composerMentions !== undefined && !composerMentions) || (value.sendConfig !== undefined && !sendConfig) || !deliveryTarget || (value.deliveryParts !== undefined && !deliveryParts) || (deliveryTarget.kind === 'assistant' && !deliveryParts) || (value.syntheticParts !== undefined && !syntheticParts) || (value.attachmentIssues !== undefined && !attachmentIssues)) return null;
  const attachments = value.attachments === undefined ? undefined : parseAttachments(value.attachments);
  if (value.attachments !== undefined && !attachments) return null;
  if (syntheticParts && deliveryParts) {
    const indexes = new Set<number>();
    const ownedAttachments = new Set<string>();
    for (const part of syntheticParts) {
      const [textIndex, ...fileIndexes] = part.deliveryPartIndexes;
      if (textIndex === undefined || indexes.has(textIndex) || deliveryParts[textIndex]?.type !== 'text' || deliveryParts[textIndex].text !== part.text) return null;
      indexes.add(textIndex);
      for (const index of fileIndexes) {
        if (indexes.has(index) || deliveryParts[index]?.type !== 'file' || !('attachmentID' in deliveryParts[index]) || deliveryParts[index].attachmentID !== part.attachmentIDs[fileIndexes.indexOf(index)]) return null;
        indexes.add(index);
      }
      for (const attachmentID of part.attachmentIDs) {
        const attachment = attachments?.find((candidate) => candidate.attachmentID === attachmentID);
        if (!attachment || ownedAttachments.has(attachmentID) || attachment.occurrenceRefID[0] !== 'part' || attachment.occurrenceRefID[1] !== part.partID || attachment.occurrenceRefID[2] !== attachmentID) return null;
        ownedAttachments.add(attachmentID);
      }
    }
    if (attachments?.some((attachment) => attachment.occurrenceRefID[0] === 'part' && !ownedAttachments.has(attachment.attachmentID))) return null;
  }
  return { queueItemID: value.queueItemID, operationID: value.operationID, messageID: value.messageID, content: value.content, status: value.status, attemptCount: value.attemptCount, position: value.position, rowVersion: value.rowVersion, createdAt: value.createdAt, deliveryTarget, ...(value.manualDispatchRequested === true ? { manualDispatchRequested: true } : {}), ...(composerDocument ? { composerDocument } : {}), ...(composerMentions ? { composerMentions } : {}), ...(sendConfig ? { sendConfig } : {}), ...(deliveryParts ? { deliveryParts } : {}), ...(syntheticParts ? { syntheticParts } : {}), ...(attachments ? { attachments } : {}), ...(attachmentIssues ? { attachmentIssues } : {}) };
};

const parseScope = (value: unknown): MessageQueueScope | null => {
  if (!isRecord(value) || typeof value.scopeID !== 'string' || !isRevision(value.revision) || typeof value.directory !== 'string' || typeof value.sessionID !== 'string' || typeof value.worktreeState !== 'string' || !isRevision(value.itemCount) || !Array.isArray(value.items) || value.items.length > 8 || (value.nextOffset !== undefined && (!isRevision(value.nextOffset) || value.nextOffset <= 0))) return null;
  const items = value.items.map(parseItem);
  return items.every((item): item is MessageQueueItem => item !== null) ? { scopeID: value.scopeID, revision: value.revision, directory: value.directory, sessionID: value.sessionID, worktreeState: value.worktreeState, itemCount: value.itemCount, items, ...(value.nextOffset === undefined ? {} : { nextOffset: value.nextOffset }) } : null;
};

const parseScopeDescriptor = (value: unknown): MessageQueueScopeDescriptor | null => (
  isRecord(value) && Object.keys(value).every((key) => scopeDescriptorKeys.has(key)) && typeof value.scopeID === 'string' && isRevision(value.revision) && typeof value.directory === 'string'
    && typeof value.sessionID === 'string' && typeof value.worktreeState === 'string' && isRevision(value.itemCount)
    ? { scopeID: value.scopeID, revision: value.revision, directory: value.directory, sessionID: value.sessionID, worktreeState: value.worktreeState, itemCount: value.itemCount }
    : null
);

const parseWorktreeOrder = (value: unknown): WorktreeOrder | null => (
  isRecord(value) && typeof value.projectDirectory === 'string' && isStringArray(value.orderedPaths) && isRevision(value.revision)
    ? { projectDirectory: value.projectDirectory, orderedPaths: value.orderedPaths, revision: value.revision }
    : null
);

const parseSnapshot = (value: unknown): MessageQueueSnapshot => {
  if (!isRecord(value) || !isRevision(value.revision) || !Array.isArray(value.scopes) || !Array.isArray(value.worktreeOrders)) return malformed();
  const scopes = value.scopes.map(parseScopeDescriptor);
  const worktreeOrders = value.worktreeOrders.map(parseWorktreeOrder);
  if (!scopes.every((scope): scope is MessageQueueScopeDescriptor => scope !== null) || !worktreeOrders.every((order): order is WorktreeOrder => order !== null)) return malformed();
  return { revision: value.revision, scopes, worktreeOrders };
};

const parseMutation = (value: unknown): MessageQueueMutationResult => {
  if (!isRecord(value) || !isRevision(value.revision) || Object.keys(value).some((key) => !mutationKeys.has(key))) return malformed();
  if ((value.scopeID !== undefined && typeof value.scopeID !== 'string') || (value.queueItemID !== undefined && typeof value.queueItemID !== 'string') || (value.rowVersion !== undefined && !isRevision(value.rowVersion)) || (value.removedQueueItemID !== undefined && typeof value.removedQueueItemID !== 'string') || (value.projectDirectory !== undefined && typeof value.projectDirectory !== 'string') || (value.token !== undefined && typeof value.token !== 'string') || (value.state !== undefined && typeof value.state !== 'string') || (value.scopeCount !== undefined && !isRevision(value.scopeCount)) || (value.statusCounts !== undefined && (!isRecord(value.statusCounts) || Object.values(value.statusCounts).some((count) => !isRevision(count))))) return malformed();
  return { revision: value.revision, ...(typeof value.scopeID === 'string' ? { scopeID: value.scopeID } : {}), ...(typeof value.queueItemID === 'string' ? { queueItemID: value.queueItemID } : {}), ...(isRevision(value.rowVersion) ? { rowVersion: value.rowVersion } : {}), ...(typeof value.removedQueueItemID === 'string' ? { removedQueueItemID: value.removedQueueItemID } : {}), ...(typeof value.projectDirectory === 'string' ? { projectDirectory: value.projectDirectory } : {}), ...(typeof value.token === 'string' ? { token: value.token } : {}), ...(typeof value.state === 'string' ? { state: value.state } : {}), ...(isRevision(value.scopeCount) ? { scopeCount: value.scopeCount } : {}), ...(isRecord(value.statusCounts) ? { statusCounts: value.statusCounts as Record<string, number> } : {}) };
};

const jsonInit = (method: string, body: object, signal?: AbortSignal): Parameters<typeof runtimeFetch>[1] => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
const mutationInit = <T extends { signal?: AbortSignal }>(method: string, input: T): Parameters<typeof runtimeFetch>[1] => {
  const { signal, ...body } = input;
  return jsonInit(method, body, signal);
};

export const fetchMessageQueueSnapshot = async (signal?: AbortSignal): Promise<MessageQueueSnapshot> => parseSnapshot(await request(ROUTE, { signal }));
export const fetchMessageQueueScope = async (scopeID: string, options: { offset?: number; limit?: number; expectedRevision?: number; signal?: AbortSignal } = {}): Promise<MessageQueueScope> => {
  const value = parseScope(await request(`${ROUTE}/scopes/${encodeURIComponent(scopeID)}`, { query: { offset: options.offset, limit: options.limit, expectedRevision: options.expectedRevision }, signal: options.signal }));
  return value ?? malformed();
};
/**
 * Wait until a message-queue tip arrives with revision > afterRevision, or the
 * OpenChamber event stream becomes ready, or the signal aborts.
 */
export const waitForMessageQueueInvalidation = (
  afterRevision: number,
  options: { signal?: AbortSignal } = {},
): Promise<'tip' | 'ready' | 'aborted'> => new Promise((resolve) => {
  const signal = options.signal;
  if (signal?.aborted) {
    resolve('aborted');
    return;
  }
  const finish = (reason: 'tip' | 'ready' | 'aborted') => {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
    resolve(reason);
  };
  const onAbort = () => finish('aborted');
  const unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type === 'event-stream-ready') {
      finish('ready');
      return;
    }
    if (event.type === 'message-queue-changed' && event.revision > afterRevision) {
      finish('tip');
    }
  });
  signal?.addEventListener('abort', onAbort, { once: true });
});
export type MessageQueueServerAuthority = 'shadow' | 'active' | 'paused';
export type MessageQueueServerStatus = { capability: boolean; authority?: MessageQueueServerAuthority; generation?: number; activationEpoch?: number; activatedAt?: number; manifestHash?: string; protocol?: number; worker?: { paused: boolean; active: number } };
export const fetchMessageQueueServerStatus = async (signal?: AbortSignal): Promise<MessageQueueServerStatus> => {
  const value = await request(`${ROUTE}/status`, { signal });
  const keys = new Set(['capability', 'authority', 'generation', 'activationEpoch', 'activatedAt', 'manifestHash', 'protocol', 'worker']);
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.has(key)) || typeof value.capability !== 'boolean') return malformed();
  if (value.authority !== undefined && value.authority !== 'shadow' && value.authority !== 'active' && value.authority !== 'paused') return malformed();
  if ((value.generation !== undefined && !isRevision(value.generation)) || (value.activationEpoch !== undefined && !isRevision(value.activationEpoch)) || (value.activatedAt !== undefined && !isRevision(value.activatedAt))) return malformed();
  if (value.protocol !== undefined && value.protocol !== 4) return malformed();
  if (value.manifestHash !== undefined && typeof value.manifestHash !== 'string') return malformed();
  if (value.worker !== undefined && (!isRecord(value.worker) || Object.keys(value.worker).some((key) => key !== 'paused' && key !== 'active') || typeof value.worker.paused !== 'boolean' || !isRevision(value.worker.active))) return malformed();
  return { capability: value.capability, ...(typeof value.authority === 'string' ? { authority: value.authority } : {}), ...(isRevision(value.generation) ? { generation: value.generation } : {}), ...(isRevision(value.activationEpoch) ? { activationEpoch: value.activationEpoch } : {}), ...(isRevision(value.activatedAt) ? { activatedAt: value.activatedAt } : {}), ...(typeof value.manifestHash === 'string' ? { manifestHash: value.manifestHash } : {}), ...(value.protocol === 4 ? { protocol: 4 } : {}), ...(isRecord(value.worker) ? { worker: { paused: value.worker.paused as boolean, active: value.worker.active as number } } : {}) };
};
export type MessageQueueImportCommit = { revision: number; importID: string; manifestHash: string; generation: number; activationEpoch: number; added: number };
export type MessageQueueImportCreate = { revision: number; importID: string; state: 'staging' | 'sealed' | 'committed' | 'abandoned' | 'expired'; duplicate?: boolean; manifestHash?: string; commit?: MessageQueueImportCommit };
export type MessageQueueImportStage = { revision: number; importID: string; staged: true; duplicate?: boolean };
export type MessageQueueImportSeal = { revision: number; importID: string; manifestHash: string; state: 'sealed'; itemCount: number };
export type MessageQueueImportActivate = { revision: number; importID: string; manifestHash: string; generation: number; activationEpoch: number; added: number };
export type MessageQueueImportLateCommit = { revision: number; importID: string; manifestHash: string; generation: number; activationEpoch: number; added: number };
export type MessageQueueImportAbandon = { revision: number; importID: string; state: 'abandoned' };
export type MessageQueueAuthorityPause = { authority: 'paused'; generation: number; revision: number };
export type MessageQueueAuthorityResume = { authority: 'active'; generation: number; revision: number };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const parseImportCreate = (value: unknown): MessageQueueImportCreate => {
  const allowed = ['revision', 'importID', 'state', 'duplicate', 'manifestHash', 'commit'];
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)) || !isRevision(value.revision) || typeof value.importID !== 'string' || !['staging', 'sealed', 'committed', 'abandoned', 'expired'].includes(String(value.state)) || (value.duplicate !== undefined && typeof value.duplicate !== 'boolean') || (value.manifestHash !== undefined && typeof value.manifestHash !== 'string')) return malformed();
  const commit = value.commit === undefined ? undefined : parseImportCommit(value.commit);
  if (value.commit !== undefined && !commit) return malformed();
  return { revision: value.revision, importID: value.importID, state: value.state as MessageQueueImportCreate['state'], ...(typeof value.duplicate === 'boolean' ? { duplicate: value.duplicate } : {}), ...(typeof value.manifestHash === 'string' ? { manifestHash: value.manifestHash } : {}), ...(commit ? { commit } : {}) };
};
const parseImportStage = (value: unknown): MessageQueueImportStage => {
  if (!isRecord(value) || !exactKeys(value, value.duplicate === undefined ? ['revision', 'importID', 'staged'] : ['revision', 'importID', 'staged', 'duplicate']) || !isRevision(value.revision) || typeof value.importID !== 'string' || value.staged !== true || (value.duplicate !== undefined && typeof value.duplicate !== 'boolean')) return malformed();
  return { revision: value.revision, importID: value.importID, staged: true, ...(typeof value.duplicate === 'boolean' ? { duplicate: value.duplicate } : {}) };
};
const parseImportSeal = (value: unknown): MessageQueueImportSeal => {
  if (!isRecord(value) || !exactKeys(value, ['revision', 'importID', 'manifestHash', 'state', 'itemCount']) || !isRevision(value.revision) || typeof value.importID !== 'string' || typeof value.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestHash) || value.state !== 'sealed' || !isRevision(value.itemCount)) return malformed();
  return { revision: value.revision, importID: value.importID, manifestHash: value.manifestHash, state: 'sealed', itemCount: value.itemCount };
};
const parseImportCommit = (value: unknown): MessageQueueImportActivate => {
  if (!isRecord(value) || !exactKeys(value, ['revision', 'importID', 'manifestHash', 'generation', 'activationEpoch', 'added']) || !isRevision(value.revision) || typeof value.importID !== 'string' || typeof value.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestHash) || !isRevision(value.generation) || !isRevision(value.activationEpoch) || !isRevision(value.added)) return malformed();
  return { revision: value.revision, importID: value.importID, manifestHash: value.manifestHash, generation: value.generation, activationEpoch: value.activationEpoch, added: value.added };
};
const parseImportActivate = (value: unknown): MessageQueueImportActivate => parseImportCommit(value);
const parseImportLateCommit = (value: unknown): MessageQueueImportLateCommit => parseImportCommit(value);
const parseImportAbandon = (value: unknown): MessageQueueImportAbandon => {
  if (!isRecord(value) || !exactKeys(value, ['revision', 'importID', 'state']) || !isRevision(value.revision) || typeof value.importID !== 'string' || value.state !== 'abandoned') return malformed();
  return { revision: value.revision, importID: value.importID, state: 'abandoned' };
};
const parseAuthority = <T extends MessageQueueAuthorityPause | MessageQueueAuthorityResume>(value: unknown, authority: T['authority']): T => {
  if (!isRecord(value) || !exactKeys(value, ['authority', 'generation', 'revision']) || value.authority !== authority || !isRevision(value.generation) || !isRevision(value.revision)) return malformed();
  return { authority, generation: value.generation, revision: value.revision } as T;
};
export const createMessageQueueImport = async (input: { requestID: string; kind: 'activation' | 'late'; clientID: string; snapshotHash: string; itemCount: number; protocol: 4; expectedGeneration: number; signal?: AbortSignal }): Promise<MessageQueueImportCreate> => parseImportCreate(await request(`${ROUTE}/imports`, mutationInit('POST', input)));
export type MessageQueueImportDetails = { state: 'staging' | 'sealed' | 'committed' | 'abandoned' | 'expired'; manifestHash?: string; itemCount: number; staged: Array<{ scopeOrdinal: number; itemOrdinal: number; payloadHash: string }>; commit?: MessageQueueImportCommit };
export const fetchMessageQueueImportDetails = async (importID: string, signal?: AbortSignal): Promise<MessageQueueImportDetails> => {
  const value = await request(`${ROUTE}/imports/${encodeURIComponent(importID)}`, { signal });
  if (!isRecord(value) || !['staging', 'sealed', 'committed', 'abandoned', 'expired'].includes(String(value.state)) || !isRevision(value.itemCount) || !Array.isArray(value.staged) || (value.manifestHash !== undefined && typeof value.manifestHash !== 'string')) return malformed();
  const staged = value.staged.map((entry) => isRecord(entry) && isRevision(entry.scopeOrdinal) && isRevision(entry.itemOrdinal) && typeof entry.payloadHash === 'string' ? { scopeOrdinal: entry.scopeOrdinal, itemOrdinal: entry.itemOrdinal, payloadHash: entry.payloadHash } : null);
  const commit = value.commit === undefined ? undefined : parseImportCommit(value.commit);
  if (!staged.every((entry): entry is NonNullable<typeof entry> => entry !== null) || (value.commit !== undefined && !commit)) return malformed();
  return { state: value.state as MessageQueueImportDetails['state'], ...(typeof value.manifestHash === 'string' ? { manifestHash: value.manifestHash } : {}), itemCount: value.itemCount, staged, ...(commit ? { commit } : {}) };
};
export const stageMessageQueueImport = async (importID: string, input: { requestID: string; scopeOrdinal: number; itemOrdinal: number; payload: { scope: { directory: string; sessionID: string }; item: MessageQueueAdmissionItem }; payloadHash: string; signal?: AbortSignal }): Promise<MessageQueueImportStage> => parseImportStage(await request(`${ROUTE}/imports/${encodeURIComponent(importID)}/items`, mutationInit('POST', input)));
export const sealMessageQueueImport = async (importID: string, input: { requestID: string; signal?: AbortSignal }): Promise<MessageQueueImportSeal> => parseImportSeal(await request(`${ROUTE}/imports/${encodeURIComponent(importID)}/seal`, mutationInit('POST', input)));
export const activateMessageQueueImport = async (importID: string, input: { requestID: string; expectedGeneration: number; manifestHash: string; protocol: 4; signal?: AbortSignal }): Promise<MessageQueueImportActivate> => parseImportActivate(await request(`${ROUTE}/imports/${encodeURIComponent(importID)}/activate`, mutationInit('POST', input)));
export const commitLateMessageQueueImport = async (importID: string, input: { requestID: string; expectedGeneration: number; manifestHash: string; protocol: 4; signal?: AbortSignal }): Promise<MessageQueueImportLateCommit> => parseImportLateCommit(await request(`${ROUTE}/imports/${encodeURIComponent(importID)}/late-commit`, mutationInit('POST', input)));
export const abandonMessageQueueImport = async (importID: string, input: { requestID: string; signal?: AbortSignal }): Promise<MessageQueueImportAbandon> => parseImportAbandon(await request(`${ROUTE}/imports/${encodeURIComponent(importID)}/abandon`, mutationInit('POST', input)));
export const pauseMessageQueueAuthority = async (input: { expectedGeneration: number; signal?: AbortSignal }): Promise<MessageQueueAuthorityPause> => parseAuthority<MessageQueueAuthorityPause>(await request(`${ROUTE}/authority/pause`, mutationInit('POST', input)), 'paused');
export const resumeMessageQueueAuthority = async (input: { expectedGeneration: number; signal?: AbortSignal }): Promise<MessageQueueAuthorityResume> => parseAuthority<MessageQueueAuthorityResume>(await request(`${ROUTE}/authority/resume`, mutationInit('POST', input)), 'active');
export type MessageQueueUpload = { uploadID: string; uploadToken: string; expiresAt: number };
export const createMessageQueueAttachmentUpload = async (input: { expiresAt?: number; signal?: AbortSignal } = {}): Promise<MessageQueueUpload> => {
  const value = await request(`${ROUTE}/attachments/uploads`, mutationInit('POST', input));
  if (!isRecord(value) || typeof value.uploadID !== 'string' || typeof value.uploadToken !== 'string' || !isRevision(value.expiresAt)) return malformed();
  return { uploadID: value.uploadID, uploadToken: value.uploadToken, expiresAt: value.expiresAt };
};
export const uploadMessageQueueAttachment = async (upload: MessageQueueUpload, body: Blob, sha256: string, signal?: AbortSignal): Promise<void> => {
  let response: Response;
  try { response = await runtimeFetch(`${ROUTE}/attachments/uploads/${encodeURIComponent(upload.uploadID)}`, { method: 'PUT', headers: { 'Content-Length': String(body.size), 'X-Message-Queue-Content-Length': String(body.size), 'X-Message-Queue-Upload-Token': upload.uploadToken, 'X-Message-Queue-Sha256': sha256 }, body, signal }); } catch { throw new MessageQueueServerError(0, 'unavailable'); }
  if (!response.ok) throw new MessageQueueServerError(response.status, await parseErrorCode(response));
};
export type MessageQueueEditReservation = { revision: number; scopeID: string; queueItemID: string; rowVersion: number; token: string; expiresAt: number; generation: number };
export type MessageQueueEditReservationRenewal = { queueItemID: string; token: string; generation: number; expiresAt: number };
const parseReservation = (value: unknown): MessageQueueEditReservation => {
  if (!isRecord(value) || !isRevision(value.revision) || typeof value.scopeID !== 'string' || typeof value.queueItemID !== 'string' || !isRevision(value.rowVersion) || typeof value.token !== 'string' || !isRevision(value.expiresAt) || !isRevision(value.generation)) return malformed();
  return { revision: value.revision, scopeID: value.scopeID, queueItemID: value.queueItemID, rowVersion: value.rowVersion, token: value.token, expiresAt: value.expiresAt, generation: value.generation };
};
const parseReservationRenewal = (value: unknown): MessageQueueEditReservationRenewal => {
  if (!isRecord(value) || typeof value.queueItemID !== 'string' || typeof value.token !== 'string' || !isRevision(value.generation) || !isRevision(value.expiresAt)) return malformed();
  return { queueItemID: value.queueItemID, token: value.token, generation: value.generation, expiresAt: value.expiresAt };
};
export const reserveMessageQueueItemForEdit = async (queueItemID: string, input: { requestID: string; expectedRevision: number; rowVersion: number; owner: string; ttlMs: number; signal?: AbortSignal }): Promise<MessageQueueEditReservation> => parseReservation(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/reserve`, mutationInit('POST', input)));
export const releaseMessageQueueItemEditReservation = async (queueItemID: string, input: { token: string; signal?: AbortSignal }): Promise<void> => { await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/release`, mutationInit('POST', input)); };
export const renewEditReservation = async (queueItemID: string, input: { token: string; generation: number; ttlMs: number; signal?: AbortSignal }): Promise<MessageQueueEditReservationRenewal> => parseReservationRenewal(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/edit-reservations/${encodeURIComponent(input.token)}/renew`, mutationInit('POST', input)));
export const removeReservedMessageQueueItem = async (queueItemID: string, input: { requestID: string; expectedRevision: number; expectedRowVersion: number; token: string; generation: number; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/reserved-remove`, mutationInit('DELETE', input)));
export const downloadMessageQueueAttachment = async (queueItemID: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>, signal?: AbortSignal): Promise<Blob> => {
  let response: Response;
  try { response = await runtimeFetch(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/attachments/${encodeURIComponent(attachment.attachmentID)}/content`, { signal }); } catch { throw new MessageQueueServerError(0, 'unavailable'); }
  if (!response.ok) throw new MessageQueueServerError(response.status, await parseErrorCode(response));
  const expectedMimeType = attachment.mimeType.trim().toLowerCase();
  const length = response.headers.get('Content-Length'), mimeType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if ((length !== null && length !== String(attachment.size)) || mimeType !== expectedMimeType) throw new MessageQueueServerError(response.status, 'unavailable');
  let body: Blob;
  try { body = await response.blob(); } catch { throw new MessageQueueServerError(response.status, 'unavailable'); }
  if (body.size !== attachment.size) throw new MessageQueueServerError(response.status, 'unavailable');
  const normalized = new Blob([body], { type: expectedMimeType });
  return normalized.type === expectedMimeType ? normalized : Object.defineProperty(normalized, 'type', { value: expectedMimeType });
};
export const admitTextQueueItem = async (input: { requestID: string; expectedRevision?: number; scope: { directory: string; sessionID: string }; item: MessageQueueAdmissionItem; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/items`, mutationInit('POST', input)));
export type MessageQueueEditItem = Pick<MessageQueueAdmissionItem, 'content' | 'composerDocument' | 'composerMentions' | 'sendConfig' | 'attachments' | 'attachmentIssues'>;
export const editTextQueueItem = async (queueItemID: string, input: { requestID: string; expectedRevision: number; expectedRowVersion: number; item: Partial<MessageQueueEditItem>; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}`, mutationInit('PATCH', input)));
export const sendQueueItemNow = async (queueItemID: string, input: { requestID: string; expectedRevision: number; expectedRowVersion: number; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}/send`, mutationInit('POST', input)));
export const removeQueueItem = async (queueItemID: string, input: { requestID: string; expectedRevision: number; expectedRowVersion: number; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/items/${encodeURIComponent(queueItemID)}`, mutationInit('DELETE', input)));
export const reorderQueueScope = async (scopeID: string, input: { requestID: string; expectedRevision: number; queueItemIDs: string[]; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/scopes/${encodeURIComponent(scopeID)}/order`, mutationInit('PUT', input)));
export const fetchWorktreeOrder = async (projectDirectory: string, signal?: AbortSignal): Promise<WorktreeOrder> => {
  const value = parseWorktreeOrder(await request(`${ROUTE}/worktrees/order`, { query: { projectDirectory }, signal }));
  return value ?? malformed();
};
export const setWorktreeOrder = async (input: { requestID: string; projectDirectory: string; expectedRevision: number; orderedPaths: string[]; signal?: AbortSignal }): Promise<MessageQueueMutationResult> => parseMutation(await request(`${ROUTE}/worktrees/order`, mutationInit('PUT', input)));
