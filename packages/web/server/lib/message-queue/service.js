import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initializeMessageQueueSchema } from './schema.js';

const require = createRequire(import.meta.url);
const MAX_CONTENT = 200_000;
const MAX_STRING = 512;
const MAX_PATH = 4_096;
const MAX_WORKTREE_PATHS = 1_024;
const MAX_SCOPES = 128;
const MAX_ITEMS = 2_048;
const MAX_WORKTREE_ORDERS = 1_024;
const MAX_ORDER_PATHS_TOTAL = 4_096;
const MAX_SCOPE_PAGE_ITEMS = 8;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS_PER_RUNTIME = 16_384;
const MAX_ATTACHMENTS = 64;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ITEM_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_COMPOSER_REFERENCES = 1_000;
const MAX_COMPOSER_REFERENCE_DISPLAY = 512;
const MAX_COMPOSER_SESSION_ID = 128;
const MAX_COMPOSER_PASTE_LENGTH = 100_000;
const MAX_COMPOSER_PASTE_TOTAL_LENGTH = 200_000;
const ITEM_KEYS = new Set(['queueItemID', 'operationID', 'messageID', 'content', 'composerDocument', 'composerMentions', 'sendConfig', 'attachments', 'attachmentIssues', 'createdAt', 'dueAt', 'migrationImport', 'migrationState']);
const EDIT_KEYS = new Set(['content', 'composerDocument', 'composerMentions', 'sendConfig', 'attachments', 'attachmentIssues', 'dueAt']);
const ADMISSION_KEYS = new Set(['requestID', 'expectedRevision', 'scope', 'item']);
const SCOPE_KEYS = new Set(['directory', 'sessionID']);
const EDIT_REQUEST_KEYS = new Set(['requestID', 'queueItemID', 'expectedRevision', 'expectedRowVersion', 'item']);
const REMOVE_REQUEST_KEYS = new Set(['requestID', 'queueItemID', 'expectedRevision', 'expectedRowVersion']);
const MANUAL_SEND_REQUEST_KEYS = new Set(['requestID', 'queueItemID', 'expectedRevision', 'expectedRowVersion']);
const REORDER_REQUEST_KEYS = new Set(['requestID', 'scopeID', 'expectedRevision', 'queueItemIDs']);
const ORDER_REQUEST_KEYS = new Set(['requestID', 'projectDirectory', 'expectedRevision', 'orderedPaths']);
const PREPARE_REQUEST_KEYS = new Set(['requestID', 'directory']);
const TOKEN_REQUEST_KEYS = new Set(['requestID', 'directory', 'token']);
const COMMIT_REQUEST_KEYS = new Set(['requestID', 'directory', 'projectDirectory', 'token']);
const SEND_CONFIG_KEYS = new Set(['providerID', 'modelID', 'agent', 'variant']);
const COMPOSER_KEYS = new Set(['text', 'references', 'composerDocument', 'composerMentions']);
const RUNTIME_KEY = /^[a-f0-9]{64}$/;

class MessageQueueError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new MessageQueueError(code); };
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const normalizeDirectory = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return normalized.length <= MAX_PATH ? normalized : null;
};
const normalizePath = (value) => {
  const normalized = normalizeDirectory(value);
  return normalized && normalized.length <= MAX_PATH ? normalized : null;
};
const normalizeRuntimeUrlKey = (value) => {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return `url:${value.trim().replace(/\/+$/, '') || 'default'}`;
  }
};
const runtimeKeyFor = (config) => crypto.createHash('sha256').update(typeof config?.apiBaseUrl === 'string' && config.apiBaseUrl.trim() ? normalizeRuntimeUrlKey(config.apiBaseUrl) : 'local-managed-opencode').digest('hex');
const hashCanonical = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) { const entries = value.map(canonical); return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(',')}]`; }
  if (plainObject(value)) { const entries = Object.keys(value).sort().map((key) => { const entry = canonical(value[key]); return entry === undefined ? undefined : `${JSON.stringify(key)}:${entry}`; }); return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(',')}}`; }
  return undefined;
};
const parse = (value) => value == null ? undefined : JSON.parse(value);
const optionalJson = (value) => value === undefined ? null : JSON.stringify(value);
const nonEmptyString = (value, limit = MAX_STRING) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const composerAttachmentIdentity = (reference) => reference.attachmentID ?? reference.uploadID ?? reference.serverPath;
const countCodePoints = (value) => Array.from(value).length;

export const createMessageQueueService = ({ dbPath, getRuntimeConfig = () => null, clock = () => Date.now(), isServerPathAllowed = () => false, onRevisionTip = null } = {}) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) return null;
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try { initializeMessageQueueSchema(db); } catch (error) { db.close(); throw error; }

  let closed = false;
  const waiters = new Set();
  const runtimeKey = () => runtimeKeyFor(getRuntimeConfig());
  const capturedRuntimeKey = (override) => {
    if (override === undefined) return runtimeKey();
    if (typeof override !== 'string' || !RUNTIME_KEY.test(override)) fail('validation_error');
    return override;
  };
  const now = () => Math.trunc(clock());
  const clearExpiredReceipts = () => db.prepare('DELETE FROM operation_receipt WHERE created_at < ?').run(now() - RECEIPT_RETENTION_MS);
  const globalRevision = () => Number(db.prepare("SELECT value FROM queue_meta WHERE key = 'global_revision'").get().value);
  const setGlobalRevision = (value) => db.prepare("UPDATE queue_meta SET value = ? WHERE key = 'global_revision'").run(String(value));
  const scopeIDFor = (key, directory, sessionID) => crypto.createHash('sha256').update(`${key}\0${directory}\0${sessionID}`).digest('hex');
  const scopeRow = (scopeID) => db.prepare('SELECT * FROM queue_scope WHERE scope_id = ?').get(scopeID);
  const itemRow = (queueItemID) => db.prepare('SELECT * FROM queue_item WHERE queue_item_id = ?').get(queueItemID);
  const lifecycle = (key, directory) => db.prepare('SELECT * FROM worktree_lifecycle WHERE runtime_key = ? AND directory = ?').get(key, directory);
  const attachmentsFor = (queueItemID) => db.prepare(`SELECT attachment.ordinal, attachment.upload_id, attachment.locator_kind, attachment.locator_value, attachment.name, attachment.media_type, attachment.size_bytes, attachment.attachment_id, attachment.occurrence_ref_id, attachment.filename, attachment.mime_type, attachment.source, attachment.locator, object.storage_key, object.object_hash
    FROM queue_attachment AS attachment LEFT JOIN attachment_object AS object ON object.object_hash = attachment.object_hash WHERE attachment.queue_item_id = ? ORDER BY attachment.ordinal`).all(queueItemID).map((attachment) => ({
    attachmentID: attachment.attachment_id ?? attachment.upload_id ?? attachment.locator_value,
    occurrenceRefID: parse(attachment.occurrence_ref_id) ?? ['root', attachment.attachment_id ?? attachment.upload_id ?? attachment.locator_value],
    filename: attachment.filename ?? attachment.name ?? 'attachment',
    mimeType: attachment.mime_type ?? attachment.media_type ?? 'application/octet-stream',
    size: attachment.size_bytes,
    source: attachment.source,
    locator: attachment.locator_kind === 'server_path' ? { kind: 'server-path', path: attachment.locator_value } : { kind: 'upload', uploadID: attachment.upload_id, ...(attachment.storage_key ? { storageKey: attachment.storage_key } : {}) },
  }));
  const itemOutput = (row) => {
    const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id = ?').get(row.queue_item_id);
    if (!attempt) fail('internal_error');
    return {
      queueItemID: row.queue_item_id, operationID: row.operation_id, messageID: attempt.message_id, content: row.content,
      scopeID: row.scope_id, directory: scopeRow(row.scope_id)?.directory, sessionID: scopeRow(row.scope_id)?.session_id,
      ...(row.composer_document ? { composerDocument: parse(row.composer_document) } : {}),
      ...(row.send_config ? { sendConfig: parse(row.send_config) } : {}),
      status: row.status, manualDispatchRequested: row.manual_dispatch_requested === 1, attemptCount: attempt.attempt_count, position: row.position, rowVersion: row.row_version, createdAt: row.created_at,
      dueAt: row.due_at, ...(row.reconciliation_due_at != null ? { reconciliationDueAt: row.reconciliation_due_at } : {}),
      attachments: attachmentsFor(row.queue_item_id), attachmentIssues: parse(row.attachment_issues) ?? [],
    };
  };
  const scopeDescriptor = (row, itemCount) => ({ scopeID: row.scope_id, revision: row.revision, directory: row.directory, sessionID: row.session_id, worktreeState: row.worktree_state, itemCount });
  const scopePage = (row, offset, limit) => {
    const itemCount = Number(db.prepare('SELECT COUNT(*) AS count FROM queue_item WHERE scope_id = ?').get(row.scope_id).count);
    const items = db.prepare('SELECT * FROM queue_item WHERE scope_id = ? ORDER BY position, queue_item_id LIMIT ? OFFSET ?').all(row.scope_id, limit, offset).map(itemOutput);
    return { ...scopeDescriptor(row, itemCount), items, ...(offset + items.length < itemCount ? { nextOffset: offset + items.length } : {}) };
  };
  const worktreeOrders = () => db.prepare('SELECT * FROM worktree_order WHERE runtime_key = ? ORDER BY project_directory').all(runtimeKey()).map((row) => ({ projectDirectory: row.project_directory, orderedPaths: parse(row.ordered_paths), revision: row.revision }));
  const snapshot = () => ({ revision: globalRevision(), scopes: db.prepare(`
    SELECT scope.*, COUNT(item.queue_item_id) AS item_count
    FROM queue_scope AS scope LEFT JOIN queue_item AS item ON item.scope_id = scope.scope_id
    WHERE scope.runtime_key = ? GROUP BY scope.scope_id ORDER BY scope.directory, scope.session_id
  `).all(runtimeKey()).map((row) => scopeDescriptor(row, Number(row.item_count))), worktreeOrders: worktreeOrders() });
  const changesSnapshot = () => ({
    revision: globalRevision(),
    scopes: db.prepare(`
      SELECT scope.scope_id, scope.revision, scope.directory, scope.session_id, scope.worktree_state, COUNT(item.queue_item_id) AS item_count
      FROM queue_scope AS scope
      LEFT JOIN queue_item AS item ON item.scope_id = scope.scope_id
      WHERE scope.runtime_key = ?
      GROUP BY scope.scope_id
      ORDER BY scope.directory, scope.session_id
    `).all(runtimeKey()).map((row) => ({
      scopeID: row.scope_id,
      revision: row.revision,
      directory: row.directory,
      sessionID: row.session_id,
      worktreeState: row.worktree_state,
      itemCount: Number(row.item_count),
    })),
    worktreeOrders: worktreeOrders(),
  });
  const publish = () => {
    for (const waiter of [...waiters]) waiter();
    if (typeof onRevisionTip === 'function') {
      try {
        onRevisionTip({ revision: globalRevision(), occurredAt: now() });
      } catch (error) {
        console.warn('[message-queue] onRevisionTip failed:', error);
      }
    }
  };
  const validateRequestID = (requestID) => { if (!nonEmptyString(requestID)) fail('validation_error'); };
  const attachmentDescriptor = (attachment, { migrationImport = false } = {}) => {
    if (!plainObject(attachment)) fail('validation_error');
    const legacy = Object.hasOwn(attachment, 'uploadID') || Object.hasOwn(attachment, 'serverPath');
    if (legacy && !migrationImport) fail('validation_error');
    const value = legacy ? {
      attachmentID: attachment.attachmentID ?? attachment.uploadID ?? attachment.serverPath,
      occurrenceRefID: attachment.occurrenceRefID ?? ['root', attachment.attachmentID ?? attachment.uploadID ?? attachment.serverPath],
      filename: attachment.filename ?? attachment.name ?? 'attachment', mimeType: attachment.mimeType ?? attachment.mediaType ?? 'application/octet-stream', size: attachment.size ?? attachment.sizeBytes,
      source: attachment.source ?? (attachment.uploadID ? 'local' : 'server'), locator: attachment.locator ?? (attachment.uploadID ? { kind: 'upload', uploadID: attachment.uploadID } : { kind: 'server-path', path: attachment.serverPath }),
    } : attachment;
    const occurrence = value.occurrenceRefID;
    if (Object.keys(value).some((key) => !['attachmentID', 'occurrenceRefID', 'filename', 'mimeType', 'size', 'source', 'locator'].includes(key)) || !nonEmptyString(value.attachmentID) || !Array.isArray(occurrence) || !((occurrence.length === 2 && occurrence[0] === 'root' && occurrence[1] === value.attachmentID) || (occurrence.length === 3 && occurrence[0] === 'part' && nonEmptyString(occurrence[1]) && occurrence[2] === value.attachmentID)) || !nonEmptyString(value.filename) || !nonEmptyString(value.mimeType) || !['local', 'vscode', 'server'].includes(value.source) || !plainObject(value.locator) || (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_ATTACHMENT_BYTES))) fail('validation_error');
    if (!legacy && value.size === undefined) fail('validation_error');
    const locator = value.locator;
    if (locator.kind === 'upload' && Object.keys(locator).every((key) => ['kind', 'uploadID'].includes(key)) && nonEmptyString(locator.uploadID)) return { ...value, occurrenceRefID: occurrence, locator: { kind: 'upload', uploadID: locator.uploadID } };
    const serverPath = locator.kind === 'server-path' && Object.keys(locator).every((key) => ['kind', 'path'].includes(key)) ? normalizePath(locator.path) : null;
    if (!serverPath) fail('validation_error');
    return { ...value, occurrenceRefID: occurrence, locator: { kind: 'server-path', path: serverPath } };
  };
  const validateAttachments = (item, required = true) => {
    if (required && (!Array.isArray(item.attachments) || !Array.isArray(item.attachmentIssues))) fail('validation_error');
    if (item.attachments !== undefined && (!Array.isArray(item.attachments) || item.attachments.length > MAX_ATTACHMENTS)) fail('validation_error');
    if (item.attachmentIssues !== undefined && (!Array.isArray(item.attachmentIssues) || item.attachmentIssues.some((issue) => !plainObject(issue)))) fail('validation_error');
    return (item.attachments ?? []).map((attachment) => attachmentDescriptor(attachment, { migrationImport: item.migrationImport === true }));
  };
  const validateComposer = (document, content) => {
    if (document === undefined) return [];
    if (!plainObject(document) || Object.keys(document).some((key) => !COMPOSER_KEYS.has(key)) || typeof document.text !== 'string' || document.text.length > MAX_CONTENT || !Array.isArray(document.references) || document.references.length > MAX_COMPOSER_REFERENCES || document.references.some((reference) => !plainObject(reference))) fail('validation_error');

    const legacyReferences = document.references.filter((reference) => reference.kind === undefined);
    if (legacyReferences.length) {
      if (legacyReferences.length !== document.references.length || document.text !== content) fail('validation_error');
      const attachmentIdentities = legacyReferences.map(composerAttachmentIdentity);
      if (attachmentIdentities.some((identity) => !nonEmptyString(identity))) fail('validation_error');
      return attachmentIdentities;
    }

    const ids = new Set();
    let previousEnd = 0;
    let cursor = 0;
    let canonical = '';
    let totalPasteLength = 0;
    for (const reference of document.references) {
      if (!nonEmptyString(reference.id, MAX_COMPOSER_REFERENCE_DISPLAY) || !nonEmptyString(reference.display, MAX_COMPOSER_REFERENCE_DISPLAY) || !nonNegativeInteger(reference.start) || !nonNegativeInteger(reference.end) || reference.end <= reference.start || reference.start < previousEnd || reference.end > document.text.length || document.text.slice(reference.start, reference.end) !== reference.display || ids.has(reference.id)) fail('validation_error');
      ids.add(reference.id);
      canonical += document.text.slice(cursor, reference.start);
      if (reference.kind === 'session' && Object.keys(reference).every((key) => ['id', 'kind', 'start', 'end', 'display', 'sessionId'].includes(key)) && nonEmptyString(reference.sessionId, MAX_COMPOSER_SESSION_ID) && /^[A-Za-z0-9_-]+$/.test(reference.sessionId)) canonical += `@session:${reference.sessionId}`;
      else if (reference.kind === 'paste' && Object.keys(reference).every((key) => ['id', 'kind', 'start', 'end', 'display', 'text', 'characterCount', 'index'].includes(key)) && typeof reference.text === 'string' && reference.text.length <= MAX_COMPOSER_PASTE_LENGTH && nonNegativeInteger(reference.characterCount) && reference.characterCount === countCodePoints(reference.text) && nonNegativeInteger(reference.index) && reference.index >= 1) {
        totalPasteLength += reference.text.length;
        if (totalPasteLength > MAX_COMPOSER_PASTE_TOTAL_LENGTH) fail('validation_error');
        canonical += reference.text;
      } else fail('validation_error');
      previousEnd = reference.end;
      cursor = reference.end;
    }
    canonical += document.text.slice(cursor);
    if (canonical !== content) fail('validation_error');
    return [];
  };
  const validateSendConfig = (config) => {
    if (config === undefined) return;
    if (!plainObject(config) || Object.keys(config).some((key) => !SEND_CONFIG_KEYS.has(key)) || !nonEmptyString(config.providerID) || !nonEmptyString(config.modelID) || ['agent', 'variant'].some((key) => config[key] !== undefined && !nonEmptyString(config[key]))) fail('validation_error');
  };
  const validateAdmission = (input) => {
    const item = input?.item;
    if (!plainObject(input) || Object.keys(input).some((key) => !ADMISSION_KEYS.has(key)) || !plainObject(input.scope) || Object.keys(input.scope).some((key) => !SCOPE_KEYS.has(key)) || !plainObject(item) || Object.keys(item).some((key) => !ITEM_KEYS.has(key))) fail('validation_error');
    if (!normalizeDirectory(input.scope.directory) || !nonEmptyString(input.scope.sessionID) || !nonEmptyString(item.queueItemID) || !nonEmptyString(item.operationID) || !nonEmptyString(item.messageID) || typeof item.content !== 'string' || item.content.length > MAX_CONTENT || !Number.isInteger(item.createdAt) || item.createdAt < 0) fail('validation_error');
    const attachments = validateAttachments(item); const composerAttachmentIdentities = validateComposer(item.composerDocument, item.content); validateSendConfig(item.sendConfig);
    if (item.composerMentions !== undefined && (!Array.isArray(item.composerMentions) || item.composerMentions.some((mention) => !plainObject(mention)))) fail('validation_error');
    if (item.dueAt !== undefined && (!Number.isSafeInteger(item.dueAt) || item.dueAt < 0)) fail('validation_error');
    if (item.migrationState !== undefined) {
      if (!item.migrationImport || !plainObject(item.migrationState) || Object.keys(item.migrationState).some((key) => !['status', 'attemptCount', 'dueAt', 'reconciliationStartedAt', 'reconciliationDeadlineAt', 'reconciliationChecks', 'reconciliationNextCheckAt', 'failureKind'].includes(key)) || !['queued', 'retrying', 'reconciling', 'unresolved', 'failed', 'sending'].includes(item.migrationState.status) || ['attemptCount', 'dueAt', 'reconciliationStartedAt', 'reconciliationDeadlineAt', 'reconciliationChecks', 'reconciliationNextCheckAt'].some((key) => item.migrationState[key] !== undefined && (!Number.isSafeInteger(item.migrationState[key]) || item.migrationState[key] < 0)) || (item.migrationState.failureKind !== undefined && !nonEmptyString(item.migrationState.failureKind))) fail('validation_error');
    }
    if (!item.migrationImport && item.attachmentIssues.length) fail('validation_error');
    if (new Set(attachments.map((attachment) => attachment.attachmentID)).size !== attachments.length || new Set(attachments.map((attachment) => JSON.stringify(attachment.occurrenceRefID))).size !== attachments.length || new Set(item.attachmentIssues.map((issue) => canonical(issue))).size !== item.attachmentIssues.length || (!item.migrationImport && item.attachmentIssues.length && attachments.length)) fail('validation_error');
    const identities = new Set(attachments.flatMap((attachment) => [attachment.attachmentID, attachment.occurrenceRefID]));
    if (composerAttachmentIdentities.some((identity) => !identities.has(identity))) fail('validation_error');
  };
  const validateEdit = (input, currentContent) => {
    if (!plainObject(input) || Object.keys(input).some((key) => !EDIT_REQUEST_KEYS.has(key)) || !plainObject(input.item) || !Object.keys(input.item).length || Object.keys(input.item).some((key) => !EDIT_KEYS.has(key))) fail('validation_error');
    const content = input.item.content ?? currentContent;
    if (typeof content !== 'string' || content.length > MAX_CONTENT) fail('validation_error');
    validateAttachments(input.item, false); validateComposer(input.item.composerDocument, content); validateSendConfig(input.item.sendConfig);
  };
  const getReceipt = (key, requestID, payloadHash, operationType) => {
    validateRequestID(requestID);
    const receipt = db.prepare('SELECT * FROM operation_receipt WHERE runtime_key = ? AND request_id = ?').get(key, requestID);
    if (!receipt) return null;
    if (receipt.created_at < now() - RECEIPT_RETENTION_MS) {
      db.prepare('DELETE FROM operation_receipt WHERE runtime_key = ? AND request_id = ?').run(key, requestID);
      return null;
    }
    if (receipt.payload_hash !== payloadHash || receipt.operation_type !== operationType) fail('idempotency_conflict');
    return JSON.parse(receipt.response_json);
  };
  const completionMatches = ({ queueItemID, operationID, messageID }) => db.prepare('SELECT * FROM queue_completion WHERE queue_item_id = ? OR operation_id = ? OR message_id = ?').all(queueItemID ?? null, operationID ?? null, messageID ?? null);
  const completedIdentity = ({ queueItemID, operationID, messageID }) => {
    const matches = completionMatches({ queueItemID, operationID, messageID });
    if (!matches.length) return null;
    const exact = matches.find((row) => row.queue_item_id === queueItemID && row.operation_id === operationID && row.message_id === messageID);
    if (exact && matches.every((row) => row.queue_item_id === queueItemID && row.operation_id === operationID && row.message_id === messageID)) return exact;
    fail('idempotency_conflict');
  };
  const completedAdmissionIdentity = ({ queueItemID, operationID, messageID }) => {
    const matches = completionMatches({ queueItemID, operationID, messageID });
    if (!matches.length) return null;
    const exact = matches.find((row) => row.queue_item_id === queueItemID && row.operation_id === operationID);
    if (exact && matches.every((row) => row.queue_item_id === queueItemID && row.operation_id === operationID)) return exact;
    fail('idempotency_conflict');
  };
  const setReceipt = (key, requestID, payloadHash, response, revision, operationType) => {
    db.prepare('DELETE FROM operation_receipt WHERE runtime_key = ? AND created_at < ?').run(key, now() - RECEIPT_RETENTION_MS);
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM operation_receipt WHERE runtime_key = ?').get(key).count);
    const excess = Math.max(0, count - (MAX_RECEIPTS_PER_RUNTIME - 1));
    if (excess) db.prepare('DELETE FROM operation_receipt WHERE rowid IN (SELECT rowid FROM operation_receipt WHERE runtime_key = ? ORDER BY created_at, rowid LIMIT ?)').run(key, excess);
    db.prepare('INSERT INTO operation_receipt(runtime_key,request_id,operation_type,payload_hash,response_json,committed_revision,created_at) VALUES (?,?,?,?,?,?,?)').run(key, requestID, operationType, payloadHash, JSON.stringify(response), revision, now());
  };
  const ensureScope = (scope, key) => {
    const directory = normalizeDirectory(scope.directory); const scopeID = scopeIDFor(key, directory, scope.sessionID);
    const state = lifecycle(key, directory)?.state ?? 'active';
    db.prepare('INSERT OR IGNORE INTO worktree_lifecycle(runtime_key,directory,state,deletion_token,updated_at) VALUES (?,?,?,NULL,?)').run(key, directory, state, now());
    if (!scopeRow(scopeID) && Number(db.prepare('SELECT COUNT(*) AS count FROM queue_scope WHERE runtime_key = ?').get(key).count) >= MAX_SCOPES) fail('validation_error');
    db.prepare('INSERT OR IGNORE INTO queue_scope(scope_id,runtime_key,directory,session_id,revision,worktree_state,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?)').run(scopeID, key, directory, scope.sessionID, state, now(), now());
    return scopeRow(scopeID);
  };
  const assertScopeRevision = (scope, expectedRevision) => { if (!Number.isInteger(expectedRevision)) fail('validation_error'); if (scope.revision !== expectedRevision) fail('revision_conflict'); };
  const assertRowVersion = (row, expectedRowVersion) => { if (!Number.isInteger(expectedRowVersion)) fail('validation_error'); if (row.row_version !== expectedRowVersion) fail('row_version_conflict'); };
  const assertEditable = (scope, row) => { if (scope.worktree_state !== 'active') fail('scope_locked'); if (row && (row.status === 'sending' || row.status === 'reconciling')) fail('scope_locked'); };
  const assertUnreserved = (queueItemID) => { const attempt = db.prepare('SELECT edit_reservation_token,edit_reservation_expires_at FROM queue_attempt WHERE queue_item_id=?').get(queueItemID); if (attempt?.edit_reservation_token && attempt.edit_reservation_expires_at > now()) fail('reserved'); };
  const assertScopeDispatchIdle = (scopeID) => { if (db.prepare("SELECT 1 FROM queue_item WHERE scope_id=? AND status IN ('sending','reconciling')").get(scopeID)) fail('scope_locked'); };
  const clearScopeEligibilityLeases = (scopeID) => db.prepare(`UPDATE queue_attempt SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_generation=NULL,fence_generation=NULL WHERE queue_item_id IN (
    SELECT queue_item_id FROM queue_item WHERE scope_id=? AND status IN ('queued','retrying')
  )`).run(scopeID);
  const touchScopes = (scopeIDs, revision) => { for (const scopeID of scopeIDs) db.prepare('UPDATE queue_scope SET revision = ?, updated_at = ? WHERE scope_id = ?').run(revision, now(), scopeID); };
  const validateServerAttachment = (attachment, scope, key) => {
    let realpath;
    try { realpath = fs.realpathSync(attachment.locator.path); } catch { fail('attachment_unavailable'); }
    let stat;
    try { stat = fs.statSync(realpath); } catch { fail('attachment_unavailable'); }
    const scopeDirectory = (() => { try { return fs.realpathSync(scope.directory); } catch { fail('attachment_unavailable'); } })();
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES || (attachment.size !== undefined && stat.size !== attachment.size) || (realpath !== scopeDirectory && !realpath.startsWith(`${scopeDirectory}${path.sep}`)) || isServerPathAllowed(realpath, key) !== true) fail('attachment_unavailable');
    return { realpath, size: stat.size };
  };
  const bindAttachments = (queueItemID, attachments, key, scope) => {
    const resolved = attachments.map((attachment) => {
      if (attachment.locator.kind === 'upload') {
        const upload = db.prepare("SELECT * FROM attachment_upload WHERE upload_id = ? AND runtime_key = ? AND state = 'ready' AND expires_at >= ?").get(attachment.locator.uploadID, key, now());
        if (!upload || !Number.isSafeInteger(upload.size_bytes) || upload.size_bytes < 0 || upload.size_bytes > MAX_ATTACHMENT_BYTES || (attachment.size !== undefined && upload.size_bytes !== attachment.size)) fail('attachment_unavailable');
        return { attachment, upload, size: upload.size_bytes };
      }
      return { attachment, ...validateServerAttachment(attachment, scope, key) };
    });
    if (resolved.reduce((total, entry) => total + entry.size, 0) > MAX_ITEM_ATTACHMENT_BYTES) fail('attachment_total_limit');
    db.prepare('DELETE FROM queue_attachment WHERE queue_item_id = ?').run(queueItemID);
    const insert = db.prepare('INSERT INTO queue_attachment(queue_item_id,ordinal,upload_id,object_hash,locator_kind,locator_value,name,media_type,size_bytes,attachment_id,occurrence_ref_id,filename,mime_type,source,locator) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    resolved.forEach(({ attachment, upload, realpath, size }, ordinal) => {
      if (upload) {
        db.prepare('UPDATE attachment_object SET last_referenced_at = ? WHERE object_hash = ?').run(now(), upload.object_hash);
        insert.run(queueItemID, ordinal, upload.upload_id, upload.object_hash, 'upload', null, attachment.filename, attachment.mimeType, size, attachment.attachmentID, JSON.stringify(attachment.occurrenceRefID), attachment.filename, attachment.mimeType, attachment.source, JSON.stringify(attachment.locator));
      } else {
        insert.run(queueItemID, ordinal, null, null, 'server_path', realpath, attachment.filename, attachment.mimeType, size, attachment.attachmentID, JSON.stringify(attachment.occurrenceRefID), attachment.filename, attachment.mimeType, attachment.source, JSON.stringify({ kind: 'server-path', path: realpath }));
      }
    });
  };
  const normalizeInterruptedSending = () => {
    const rows = db.prepare("SELECT item.queue_item_id,item.scope_id FROM queue_item item JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id WHERE item.status = 'sending' AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= ?)").all(now());
    if (!rows.length) return;
    const ids = rows.map((row) => row.queue_item_id); const placeholders = ids.map(() => '?').join(',');
    db.exec('BEGIN IMMEDIATE');
    try {
      const revision = globalRevision() + 1;
      db.prepare(`UPDATE queue_item SET status='reconciling',reconciliation_due_at=?,manual_dispatch_requested=0,row_version=row_version+1,updated_at=? WHERE queue_item_id IN (${placeholders})`).run(now(), now(), ...ids);
      db.prepare(`UPDATE queue_attempt SET reconciliation_state='reconciling',reconciliation_started_at=COALESCE(reconciliation_started_at,?),reconciliation_deadline_at=COALESCE(reconciliation_deadline_at,?),reconciliation_next_check_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id IN (${placeholders})`).run(now(), now() + 30_000, now(), ...ids);
      touchScopes(rows.map((row) => row.scope_id), revision); setGlobalRevision(revision); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const recoverExpiredSending = ({ runtimeKey: override } = {}) => {
    const key = capturedRuntimeKey(override);
    return workerMutation(key, () => {
      const rows = db.prepare(`SELECT item.queue_item_id,item.scope_id FROM queue_item item JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id JOIN queue_scope scope ON scope.scope_id=item.scope_id WHERE scope.runtime_key=? AND item.status='sending' AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= ?)`).all(key, now());
      if (!rows.length) return { value: { recovered: 0 }, scopeIDs: [] };
      const ids = rows.map((row) => row.queue_item_id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE queue_item SET status='reconciling',reconciliation_due_at=?,manual_dispatch_requested=0,row_version=row_version+1,updated_at=? WHERE queue_item_id IN (${placeholders})`).run(now(), now(), ...ids);
      db.prepare(`UPDATE queue_attempt SET reconciliation_state='reconciling',reconciliation_started_at=COALESCE(reconciliation_started_at,?),reconciliation_deadline_at=COALESCE(reconciliation_deadline_at,?),reconciliation_next_check_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id IN (${placeholders})`).run(now(), now() + 30_000, now(), ...ids);
      return { value: { recovered: ids.length }, scopeIDs: rows.map((row) => row.scope_id) };
    });
  };
  const transaction = (requestID, input, operationType, mutate, key = runtimeKey()) => {
    let jsonInput;
    try {
      const encoded = JSON.stringify(input);
      if (encoded === undefined) fail('validation_error');
      jsonInput = JSON.parse(encoded);
    } catch {
      fail('validation_error');
    }
    const payload = canonical(jsonInput);
    if (payload === undefined) fail('validation_error');
    const payloadHash = hashCanonical(payload);
    let changed = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = getReceipt(key, requestID, payloadHash, operationType); if (existing) { db.exec('COMMIT'); return existing; }
      const nextRevision = globalRevision() + 1;
      const response = mutate(nextRevision, key);
      setGlobalRevision(nextRevision); setReceipt(key, requestID, payloadHash, response, nextRevision, operationType); db.exec('COMMIT'); changed = true; return response;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { if (changed) publish(); }
  };
  const importTransaction = (requestID, input, operationType, mutate, key = runtimeKey()) => {
    const payload = canonical(input); if (payload === undefined) fail('validation_error'); const payloadHash = hashCanonical(payload);
    db.exec('BEGIN IMMEDIATE');
    try { const existing = getReceipt(key, requestID, payloadHash, operationType); if (existing) { db.exec('COMMIT'); return existing; } const response = mutate(key); setReceipt(key, requestID, payloadHash, response, globalRevision(), operationType); db.exec('COMMIT'); return response; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const getScope = (scopeID, { offset = 0, limit = MAX_SCOPE_PAGE_ITEMS, expectedRevision } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPE_PAGE_ITEMS) fail('validation_error');
    if (offset > 0 && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail('validation_error');
    const scope = scopeRow(scopeID); if (!scope || scope.runtime_key !== runtimeKey()) fail('not_found'); if (offset > 0 && scope.revision !== expectedRevision) fail('revision_conflict'); return scopePage(scope, offset, limit);
  };
  const admit = (input) => transaction(input?.requestID, input, 'queue', (revision, key) => {
    validateAdmission(input); const completed = completedAdmissionIdentity(input.item); if (completed) return { revision, queueItemID: completed.queue_item_id, operationID: completed.operation_id, messageID: completed.message_id, completed: true, duplicate: true }; const scope = ensureScope(input.scope, key); assertEditable(scope); if (input.expectedRevision !== undefined) assertScopeRevision(scope, input.expectedRevision);
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM queue_item WHERE scope_id IN (SELECT scope_id FROM queue_scope WHERE runtime_key = ?)').get(key).count) >= MAX_ITEMS || itemRow(input.item.queueItemID) || db.prepare('SELECT 1 FROM queue_item WHERE operation_id = ?').get(input.item.operationID) || db.prepare('SELECT 1 FROM queue_attempt WHERE message_id = ?').get(input.item.messageID)) fail('validation_error');
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM queue_item WHERE scope_id = ?').get(scope.scope_id).position;
    const admittedDocument = input.item.composerDocument && input.item.composerMentions !== undefined ? { ...input.item.composerDocument, composerMentions: input.item.composerMentions } : input.item.composerDocument;
    const imported = input.item.migrationState;
    const admittedStatus = input.item.migrationImport && input.item.attachmentIssues.length ? 'unresolved' : imported?.status === 'sending' ? 'unresolved' : imported?.status ?? 'queued';
    db.prepare('INSERT INTO queue_item(queue_item_id,operation_id,scope_id,content,composer_document,send_config,position,status,row_version,created_at,updated_at,due_at,attachment_issues) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)').run(input.item.queueItemID,input.item.operationID,scope.scope_id,input.item.content,optionalJson(admittedDocument),optionalJson(input.item.sendConfig),position,admittedStatus,input.item.createdAt,now(),input.item.dueAt ?? now(),JSON.stringify(input.item.attachmentIssues));
    db.prepare('INSERT INTO queue_attempt(queue_item_id,message_id,attempt_count,reconciliation_state,reconciliation_started_at,reconciliation_deadline_at,reconciliation_checks,reconciliation_next_check_at,last_error_code) VALUES (?,?,?,?,?,?,?,?,?)').run(input.item.queueItemID,input.item.messageID,imported?.attemptCount ?? 0,admittedStatus === 'reconciling' ? 'reconciling' : null,imported?.reconciliationStartedAt ?? null,imported?.reconciliationDeadlineAt ?? null,imported?.reconciliationChecks ?? 0,imported?.reconciliationNextCheckAt ?? null,imported?.failureKind ?? null);
    if (imported?.dueAt !== undefined || admittedStatus === 'reconciling') db.prepare('UPDATE queue_item SET due_at=?,reconciliation_due_at=?,last_error_code=? WHERE queue_item_id=?').run(imported?.dueAt ?? now(), admittedStatus === 'reconciling' ? (imported?.reconciliationNextCheckAt ?? now()) : null, imported?.failureKind ?? null, input.item.queueItemID);
    bindAttachments(input.item.queueItemID, validateAttachments(input.item), key, scope);
    touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id, queueItemID: input.item.queueItemID, rowVersion: itemRow(input.item.queueItemID).row_version };
  });
  const edit = (input) => transaction(input?.requestID, input, 'queue', (revision, key) => {
    const row = itemRow(input?.queueItemID); if (!row) fail('not_found'); validateEdit(input, row.content); const scope = scopeRow(row.scope_id); if (scope.runtime_key !== key) fail('not_found'); assertEditable(scope, row); assertScopeRevision(scope, input.expectedRevision); assertRowVersion(row, input.expectedRowVersion); assertUnreserved(row.queue_item_id);
    const editedDocument = input.item.composerDocument === undefined ? row.composer_document : optionalJson(input.item.composerDocument && input.item.composerMentions !== undefined ? { ...input.item.composerDocument, composerMentions: input.item.composerMentions } : input.item.composerDocument);
    db.prepare('UPDATE queue_item SET content=?,composer_document=?,send_config=?,due_at=?,attachment_issues=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=?').run(input.item.content ?? row.content,editedDocument,input.item.sendConfig === undefined ? row.send_config : optionalJson(input.item.sendConfig),input.item.dueAt ?? row.due_at,input.item.attachmentIssues === undefined ? row.attachment_issues : JSON.stringify(input.item.attachmentIssues),now(),row.queue_item_id);
    if (input.item.attachments !== undefined) bindAttachments(row.queue_item_id, validateAttachments(input.item, false), key, scope);
    touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id, queueItemID: row.queue_item_id, rowVersion: itemRow(row.queue_item_id).row_version };
  });
  const remove = (input) => transaction(input?.requestID, input, 'queue', (revision, key) => {
    if (!plainObject(input) || Object.keys(input).some((key) => !REMOVE_REQUEST_KEYS.has(key))) fail('validation_error'); const row = itemRow(input?.queueItemID); if (!row) fail('not_found'); const scope = scopeRow(row.scope_id); if (scope.runtime_key !== key) fail('not_found'); assertScopeRevision(scope, input.expectedRevision); assertRowVersion(row, input.expectedRowVersion); if (row.status === 'sending' || row.status === 'reconciling') fail('scope_locked'); assertUnreserved(row.queue_item_id);
    db.prepare('DELETE FROM queue_item WHERE queue_item_id = ?').run(row.queue_item_id); touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id, removedQueueItemID: row.queue_item_id };
  });
  const manualSend = (input) => transaction(input?.requestID, input, 'queue:manual-send', (revision, key) => {
    if (!plainObject(input) || Object.keys(input).some((entry) => !MANUAL_SEND_REQUEST_KEYS.has(entry))) fail('validation_error');
    const row = itemRow(input.queueItemID); if (!row) fail('not_found'); const scope = scopeRow(row.scope_id); if (scope.runtime_key !== key) fail('not_found'); assertScopeRevision(scope, input.expectedRevision); assertRowVersion(row, input.expectedRowVersion); if (!['queued', 'retrying', 'failed', 'unresolved'].includes(row.status)) fail('scope_locked'); assertUnreserved(row.queue_item_id); assertScopeDispatchIdle(scope.scope_id); clearScopeEligibilityLeases(scope.scope_id);
    db.prepare('UPDATE queue_item SET position=position+1 WHERE scope_id=? AND position<?').run(scope.scope_id, row.position);
    db.prepare("UPDATE queue_item SET position=0,status='queued',due_at=?,reconciliation_due_at=NULL,dispatch_generation=NULL,manual_dispatch_requested=1,last_error_code=NULL,row_version=row_version+1,updated_at=? WHERE queue_item_id=?").run(now(), now(), row.queue_item_id);
    db.prepare('UPDATE queue_attempt SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,reconciliation_state=NULL,reconciliation_started_at=NULL,reconciliation_deadline_at=NULL,reconciliation_next_check_at=NULL,last_error_code=NULL WHERE queue_item_id=?').run(row.queue_item_id);
    touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id, queueItemID: row.queue_item_id, rowVersion: itemRow(row.queue_item_id).row_version };
  });
  const reserveForEdit = (input) => transaction(input?.requestID, input, 'queue:edit-reserve', (revision, key) => {
    if (!plainObject(input) || !['requestID', 'expectedRevision', 'rowVersion', 'owner', 'ttlMs', 'queueItemID'].every((field) => Object.hasOwn(input, field)) || !nonEmptyString(input.owner) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 300_000) fail('validation_error');
    const row = itemRow(input.queueItemID); if (!row) fail('not_found'); const scope = scopeRow(row.scope_id); if (scope.runtime_key !== key) fail('not_found'); assertScopeRevision(scope, input.expectedRevision); assertRowVersion(row, input.rowVersion); if (!['queued', 'retrying', 'failed', 'unresolved'].includes(row.status)) fail('scope_locked');
    const authority = authorityRow(key); const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(row.queue_item_id); if (attempt.edit_reservation_expires_at >= now() && attempt.edit_reservation_token) fail('reserved');
    const token = crypto.randomUUID(); const expiresAt = now() + input.ttlMs;
    db.prepare('UPDATE queue_attempt SET edit_reservation_token=?,edit_reservation_owner=?,edit_reservation_expires_at=?,edit_reservation_generation=? WHERE queue_item_id=?').run(token, input.owner, expiresAt, authority.generation, row.queue_item_id);
    return { revision, scopeID: scope.scope_id, queueItemID: row.queue_item_id, rowVersion: row.row_version, token, expiresAt, generation: authority.generation };
  });
  const releaseEditReservation = ({ queueItemID, token } = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey); if (!nonEmptyString(queueItemID) || !nonEmptyString(token)) fail('validation_error'); const row = itemRow(queueItemID); if (!row || scopeRow(row.scope_id)?.runtime_key !== key) fail('not_found'); const result = db.prepare('UPDATE queue_attempt SET edit_reservation_token=NULL,edit_reservation_owner=NULL,edit_reservation_expires_at=NULL,edit_reservation_generation=NULL WHERE queue_item_id=? AND edit_reservation_token=?').run(queueItemID, token); if (!result.changes) fail('reserved'); return { queueItemID, released: true };
  };
  const renewEditReservation = (input = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey);
    if (!plainObject(input) || Object.keys(input).some((entry) => !['queueItemID', 'token', 'generation', 'ttlMs'].includes(entry))) fail('validation_error');
    const { queueItemID, token, generation, ttlMs } = input;
    if (!nonEmptyString(queueItemID) || !nonEmptyString(token) || !Number.isInteger(generation) || generation < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) fail('validation_error');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = itemRow(queueItemID); if (!row || scopeRow(row.scope_id)?.runtime_key !== key) fail('not_found'); if (!['queued', 'retrying', 'failed', 'unresolved'].includes(row.status)) fail('scope_locked');
      const authority = authorityRow(key); if (authority.generation !== generation) fail('reservation_generation_conflict');
      const attempt = db.prepare('SELECT edit_reservation_token,edit_reservation_expires_at,edit_reservation_generation FROM queue_attempt WHERE queue_item_id=?').get(queueItemID);
      if (attempt?.edit_reservation_token !== token) fail('reservation_token_mismatch'); if (attempt.edit_reservation_generation !== generation) fail('reservation_generation_conflict'); if (attempt.edit_reservation_expires_at <= now()) fail('reservation_expired');
      const expiresAt = now() + ttlMs;
      const renewed = db.prepare('UPDATE queue_attempt SET edit_reservation_expires_at=? WHERE queue_item_id=? AND edit_reservation_token=? AND edit_reservation_generation=? AND edit_reservation_expires_at>?').run(expiresAt, queueItemID, token, generation, now());
      if (!renewed.changes) fail('reservation_expired'); db.exec('COMMIT'); return { queueItemID, token, generation, expiresAt };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const reservedRemove = (input) => transaction(input?.requestID, input, 'queue:reserved-remove', (revision, key) => {
    const allowed = new Set(['requestID', 'queueItemID', 'expectedRevision', 'expectedRowVersion', 'token', 'generation']);
    if (!plainObject(input) || Object.keys(input).some((entry) => !allowed.has(entry)) || !nonEmptyString(input.token) || !Number.isInteger(input.generation) || input.generation < 0) fail('validation_error');
    const row = itemRow(input.queueItemID); if (!row) fail('not_found'); const scope = scopeRow(row.scope_id); if (scope.runtime_key !== key) fail('not_found'); assertScopeRevision(scope, input.expectedRevision); assertRowVersion(row, input.expectedRowVersion);
    const deleted = db.prepare('DELETE FROM queue_item WHERE queue_item_id=? AND row_version=? AND EXISTS (SELECT 1 FROM queue_attempt WHERE queue_item_id=? AND edit_reservation_token=? AND edit_reservation_generation=? AND edit_reservation_expires_at>?)').run(row.queue_item_id, input.expectedRowVersion, row.queue_item_id, input.token, input.generation, now());
    if (!deleted.changes) fail('reserved'); touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id, removedQueueItemID: row.queue_item_id };
  });
  const reorder = (input) => transaction(input?.requestID, input, 'queue', (revision, key) => {
    if (!plainObject(input) || Object.keys(input).some((key) => !REORDER_REQUEST_KEYS.has(key))) fail('validation_error'); const scope = scopeRow(input?.scopeID); if (!scope || scope.runtime_key !== key) fail('not_found'); assertEditable(scope); assertScopeRevision(scope, input.expectedRevision); assertScopeDispatchIdle(scope.scope_id);
    const ids = input?.queueItemIDs; const current = db.prepare('SELECT queue_item_id FROM queue_item WHERE scope_id = ? ORDER BY position, queue_item_id').all(scope.scope_id).map((row) => row.queue_item_id); if (db.prepare('SELECT 1 FROM queue_attempt attempt JOIN queue_item item ON item.queue_item_id=attempt.queue_item_id WHERE item.scope_id=? AND attempt.edit_reservation_token IS NOT NULL AND attempt.edit_reservation_expires_at>?').get(scope.scope_id, now())) fail('reserved');
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== current.length || ids.some((id) => !current.includes(id))) fail('validation_error'); clearScopeEligibilityLeases(scope.scope_id);
    const update = db.prepare('UPDATE queue_item SET position = ?, row_version = row_version + 1, updated_at = ? WHERE queue_item_id = ?'); ids.forEach((id, index) => update.run(index, now(), id)); touchScopes([scope.scope_id], revision); return { revision, scopeID: scope.scope_id };
  });
  const getWorktreeOrderFor = (key, projectDirectory) => { const normalized = normalizeDirectory(projectDirectory); if (!normalized) fail('validation_error'); const row = db.prepare('SELECT * FROM worktree_order WHERE runtime_key = ? AND project_directory = ?').get(key, normalized); return { projectDirectory: normalized, orderedPaths: row ? parse(row.ordered_paths) : [], revision: row?.revision ?? 0 }; };
  const getWorktreeOrder = (projectDirectory) => getWorktreeOrderFor(runtimeKey(), projectDirectory);
  const getWorktreeLifecycle = (directory, options = {}) => { const normalized = normalizeDirectory(directory); if (!normalized) fail('validation_error'); const record = lifecycle(capturedRuntimeKey(options.runtimeKey), normalized); return record ? { state: record.state, token: record.deletion_token } : { state: 'active', token: null }; };
  const setWorktreeOrder = (input) => transaction(input?.requestID, input, 'worktree_order', (revision, key) => {
    if (!plainObject(input) || Object.keys(input).some((key) => !ORDER_REQUEST_KEYS.has(key))) fail('validation_error'); const projectDirectory = normalizeDirectory(input?.projectDirectory); if (!projectDirectory || !Number.isInteger(input?.expectedRevision) || !Array.isArray(input?.orderedPaths)) fail('validation_error');
    if (input.orderedPaths.length > MAX_WORKTREE_PATHS) fail('validation_error'); const orderedPaths = input.orderedPaths.map(normalizePath); if (orderedPaths.some((path) => !path) || new Set(orderedPaths).size !== orderedPaths.length) fail('validation_error'); const current = getWorktreeOrderFor(key, projectDirectory); if (!db.prepare('SELECT 1 FROM worktree_order WHERE runtime_key = ? AND project_directory = ?').get(key, projectDirectory) && Number(db.prepare('SELECT COUNT(*) AS count FROM worktree_order WHERE runtime_key = ?').get(key).count) >= MAX_WORKTREE_ORDERS) fail('validation_error'); const total = Number(db.prepare('SELECT COALESCE(SUM(json_array_length(ordered_paths)), 0) AS count FROM worktree_order WHERE runtime_key = ?').get(key).count) - current.orderedPaths.length + orderedPaths.length; if (total > MAX_ORDER_PATHS_TOTAL) fail('validation_error'); if (current.revision !== input.expectedRevision) fail('revision_conflict');
    db.prepare('INSERT INTO worktree_order(runtime_key,project_directory,ordered_paths,revision,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(runtime_key,project_directory) DO UPDATE SET ordered_paths=excluded.ordered_paths,revision=excluded.revision,updated_at=excluded.updated_at').run(key,projectDirectory,JSON.stringify(orderedPaths),revision,now()); return { revision, projectDirectory };
  });
  const lifecycleMutation = (input, state, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey);
    return transaction(input?.requestID, input, `lifecycle:${state}`, (revision) => {
    const allowed = state === 'deleting' ? PREPARE_REQUEST_KEYS : state === 'deleted' ? COMMIT_REQUEST_KEYS : TOKEN_REQUEST_KEYS;
    if (!plainObject(input) || Object.keys(input).some((entry) => !allowed.has(entry))) fail('validation_error');
    const directory = normalizeDirectory(input?.directory); if (!directory) fail('validation_error'); const old = lifecycle(key, directory); let token = null;
    if (state === 'deleting' && old?.state === 'deleting') { token = old.deletion_token; const counts = db.prepare('SELECT status, COUNT(*) AS count FROM queue_item WHERE scope_id IN (SELECT scope_id FROM queue_scope WHERE runtime_key = ? AND directory = ?) GROUP BY status').all(key, directory).reduce((result, row) => ({ ...result, [row.status]: row.count }), {}); return { revision, token, state: 'deleting', scopeCount: db.prepare('SELECT COUNT(*) AS count FROM queue_scope WHERE runtime_key = ? AND directory = ?').get(key, directory).count, statusCounts: counts }; }
    if (state === 'deleting') { token = crypto.randomUUID(); }
    else if (!old || old.deletion_token !== input.token) fail('not_found');
    db.prepare('INSERT INTO worktree_lifecycle(runtime_key,directory,state,deletion_token,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(runtime_key,directory) DO UPDATE SET state=excluded.state,deletion_token=excluded.deletion_token,updated_at=excluded.updated_at').run(key,directory,state,token,now());
    const scopes = db.prepare('SELECT scope_id FROM queue_scope WHERE runtime_key = ? AND directory = ?').all(key, directory).map((row) => row.scope_id); db.prepare('UPDATE queue_scope SET worktree_state = ?, revision = ?, updated_at = ? WHERE runtime_key = ? AND directory = ?').run(state,revision,now(),key,directory);
    const counts = db.prepare('SELECT status, COUNT(*) AS count FROM queue_item WHERE scope_id IN (SELECT scope_id FROM queue_scope WHERE runtime_key = ? AND directory = ?) GROUP BY status').all(key,directory).reduce((result,row) => ({ ...result, [row.status]: row.count }), {});
    if (state === 'deleted' && input.projectDirectory !== undefined) {
      const projectDirectory = normalizeDirectory(input.projectDirectory);
      if (!projectDirectory) fail('validation_error');
      const orderRow = db.prepare('SELECT * FROM worktree_order WHERE runtime_key = ? AND project_directory = ?').get(key, projectDirectory);
      if (orderRow) {
        const orderedPaths = parse(orderRow.ordered_paths).filter((path) => normalizePath(path) !== directory);
        if (orderedPaths.length !== parse(orderRow.ordered_paths).length) {
          db.prepare('UPDATE worktree_order SET ordered_paths = ?, revision = ?, updated_at = ? WHERE runtime_key = ? AND project_directory = ?').run(JSON.stringify(orderedPaths), revision, now(), key, projectDirectory);
        }
      }
    }
    return { revision, ...(token ? { token } : {}), state, scopeCount: scopes.length, statusCounts: counts };
    }, key);
  };
  const markWorktreeActive = (input, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey);
    return transaction(input?.requestID, input, 'lifecycle:mark-active', (revision) => { if (!plainObject(input) || Object.keys(input).some((key) => !PREPARE_REQUEST_KEYS.has(key))) fail('validation_error'); const directory = normalizeDirectory(input?.directory); if (!directory) fail('validation_error'); if (lifecycle(key, directory)?.state === 'deleting') fail('scope_locked'); db.prepare("INSERT INTO worktree_lifecycle(runtime_key,directory,state,deletion_token,updated_at) VALUES (?,?,'active',NULL,?) ON CONFLICT(runtime_key,directory) DO UPDATE SET state='active',deletion_token=NULL,updated_at=excluded.updated_at").run(key,directory,now()); db.prepare("UPDATE queue_scope SET worktree_state='active',revision=?,updated_at=? WHERE runtime_key=? AND directory=?").run(revision,now(),key,directory); return { revision, state: 'active' }; }, key);
  };
  const authorityRow = (key) => db.prepare('SELECT authority, generation, activation_epoch, activated_at, manifest_hash, protocol FROM queue_runtime WHERE runtime_key = ?').get(key) ?? { authority: 'shadow', generation: 0, activation_epoch: 0, activated_at: null, manifest_hash: null, protocol: 4 };
  const getAuthority = (options = {}) => { const authority = authorityRow(capturedRuntimeKey(options.runtimeKey)); return { authority: authority.authority, generation: authority.generation, activationEpoch: authority.activation_epoch, ...(authority.activated_at === null ? {} : { activatedAt: authority.activated_at }), ...(authority.manifest_hash === null ? {} : { manifestHash: authority.manifest_hash }), protocol: authority.protocol }; };
  const setAuthority = ({ authority, expectedGeneration } = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey); if (!['shadow', 'active', 'paused'].includes(authority) || !Number.isInteger(expectedGeneration) || expectedGeneration < 0) fail('validation_error');
    let changed = false; db.exec('BEGIN IMMEDIATE');
    try {
      const current = authorityRow(key); if (current.generation !== expectedGeneration) fail('generation_conflict');
      const generation = current.generation + 1; db.prepare('INSERT INTO queue_runtime(runtime_key,authority,generation,updated_at) VALUES (?,?,?,?) ON CONFLICT(runtime_key) DO UPDATE SET authority=excluded.authority,generation=excluded.generation,updated_at=excluded.updated_at').run(key, authority, generation, now());
      const revision = globalRevision() + 1; setGlobalRevision(revision); db.exec('COMMIT'); changed = true; return { authority, generation, revision };
    } catch (error) { db.exec('ROLLBACK'); throw error; } finally { if (changed) publish(); }
  };
  const workerMutation = (key, mutate) => {
    let changed = false; db.exec('BEGIN IMMEDIATE');
    try { const result = mutate(); if (!result?.scopeIDs?.length) { db.exec('COMMIT'); return result?.value; } const revision = globalRevision() + 1; touchScopes([...new Set(result.scopeIDs)], revision); setGlobalRevision(revision); db.exec('COMMIT'); changed = true; return { ...result.value, revision }; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { if (changed) publish(); }
  };
  const reserveEligibilityCandidate = ({ owner, leaseMs = 15_000, runtimeKey: override } = {}) => {
    const key = capturedRuntimeKey(override); if (!nonEmptyString(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) fail('validation_error');
    return workerMutation(key, () => {
      const authority = authorityRow(key); if (authority.authority !== 'active') return { value: null, scopeIDs: [] };
      const timestamp = now();
      const row = db.prepare(`SELECT item.* FROM queue_item AS item JOIN queue_scope AS scope ON scope.scope_id=item.scope_id
        WHERE scope.runtime_key=? AND scope.worktree_state='active' AND item.status IN ('queued','retrying') AND item.due_at<=? AND NOT EXISTS (SELECT 1 FROM queue_attempt reserved WHERE reserved.queue_item_id=item.queue_item_id AND reserved.edit_reservation_token IS NOT NULL AND reserved.edit_reservation_expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM queue_item active_item JOIN queue_attempt active_attempt ON active_attempt.queue_item_id=active_item.queue_item_id WHERE active_item.scope_id=item.scope_id AND (active_item.status IN ('sending','reconciling') OR (active_attempt.lease_token IS NOT NULL AND active_attempt.lease_expires_at>? AND active_attempt.lease_generation=?)))
        AND item.position=(SELECT MIN(peer.position) FROM queue_item AS peer WHERE peer.scope_id=item.scope_id)
        ORDER BY item.due_at,item.created_at,item.queue_item_id LIMIT 1`).get(key, timestamp, timestamp, timestamp, authority.generation);
      if (!row) return { value: null, scopeIDs: [] };
      const token = crypto.randomUUID(); const expires = timestamp + leaseMs;
      const reserved = db.prepare('UPDATE queue_attempt SET lease_owner=?,lease_token=?,lease_expires_at=?,lease_generation=?,fence_generation=? WHERE queue_item_id=? AND (lease_expires_at IS NULL OR lease_expires_at<=? OR lease_generation<>?)').run(owner, token, expires, authority.generation, authority.generation, row.queue_item_id, timestamp, authority.generation);
      if (!reserved.changes) return { value: null, scopeIDs: [] };
      return { value: { item: itemOutput(itemRow(row.queue_item_id)), eligibilityToken: token, leaseExpiresAt: expires, fenceGeneration: authority.generation, dispatchMode: row.manual_dispatch_requested ? 'manual' : 'automatic' }, scopeIDs: [] };
    });
  };
  const deferEligibilityCandidate = ({ queueItemID, eligibilityToken, fenceGeneration, delayMs = 1_000, runtimeKey: override } = {}) => {
    const key = capturedRuntimeKey(override); if (!nonEmptyString(queueItemID) || !nonEmptyString(eligibilityToken) || !Number.isInteger(fenceGeneration) || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 300_000) fail('validation_error');
    return workerMutation(key, () => {
      const attempt = db.prepare(`SELECT attempt.queue_item_id FROM queue_attempt attempt JOIN queue_item item ON item.queue_item_id=attempt.queue_item_id JOIN queue_scope scope ON scope.scope_id=item.scope_id JOIN queue_runtime runtime ON runtime.runtime_key=scope.runtime_key
        WHERE attempt.queue_item_id=? AND attempt.lease_token=? AND attempt.fence_generation=? AND attempt.lease_generation=? AND runtime.runtime_key=? AND runtime.authority='active' AND runtime.generation=? AND item.status IN ('queued','retrying')`).get(queueItemID, eligibilityToken, fenceGeneration, fenceGeneration, key, fenceGeneration);
      if (!attempt) return { value: { queueItemID, deferred: false }, scopeIDs: [] };
      db.prepare('UPDATE queue_attempt SET lease_expires_at=? WHERE queue_item_id=? AND lease_token=? AND fence_generation=?').run(now() + delayMs, queueItemID, eligibilityToken, fenceGeneration);
      return { value: { queueItemID, deferred: true }, scopeIDs: [] };
    });
  };
  const claimNext = ({ owner, leaseMs = 30_000, queueItemID, eligibilityToken, runtimeKey: override } = {}) => {
    const key = capturedRuntimeKey(override); const reservedClaim = eligibilityToken !== undefined;
    if (!nonEmptyString(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || (queueItemID !== undefined && !nonEmptyString(queueItemID)) || (reservedClaim && (!nonEmptyString(queueItemID) || !nonEmptyString(eligibilityToken)))) fail('validation_error');
    return workerMutation(key, () => {
      const authority = authorityRow(key); if (authority.authority !== 'active') return { value: null, scopeIDs: [] };
      const timestamp = now();
      const row = db.prepare(`SELECT item.*, scope.runtime_key FROM queue_item AS item JOIN queue_scope AS scope ON scope.scope_id=item.scope_id
        WHERE scope.runtime_key=? AND scope.worktree_state='active' AND item.status IN ('queued','retrying') AND item.due_at<=? AND (? IS NULL OR item.queue_item_id=?) AND NOT EXISTS (SELECT 1 FROM queue_attempt reserved WHERE reserved.queue_item_id=item.queue_item_id AND reserved.edit_reservation_token IS NOT NULL AND reserved.edit_reservation_expires_at>?)
        AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM queue_attempt worker_reserved WHERE worker_reserved.queue_item_id=item.queue_item_id AND worker_reserved.lease_token IS NOT NULL AND worker_reserved.lease_expires_at>? AND worker_reserved.lease_generation=?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM queue_attempt probe WHERE probe.queue_item_id=item.queue_item_id AND probe.lease_token=? AND probe.lease_expires_at>? AND probe.fence_generation=? AND probe.lease_generation=?))
        AND NOT EXISTS (SELECT 1 FROM queue_item active_item JOIN queue_attempt active_attempt ON active_attempt.queue_item_id=active_item.queue_item_id WHERE active_item.scope_id=item.scope_id AND active_item.queue_item_id<>item.queue_item_id AND (active_item.status IN ('sending','reconciling') OR (active_attempt.lease_token IS NOT NULL AND active_attempt.lease_expires_at>? AND active_attempt.lease_generation=?)))
        AND item.position=(SELECT MIN(peer.position) FROM queue_item AS peer WHERE peer.scope_id=item.scope_id)
        ORDER BY item.due_at,item.created_at,item.queue_item_id LIMIT 1`).get(key, timestamp, queueItemID ?? null, queueItemID ?? null, timestamp, eligibilityToken ?? null, timestamp, authority.generation, eligibilityToken ?? null, eligibilityToken ?? null, timestamp, authority.generation, authority.generation, timestamp, authority.generation);
      if (!row) return { value: null, scopeIDs: [] };
      const token = eligibilityToken ?? crypto.randomUUID(); const expires = timestamp + leaseMs;
      const updated = db.prepare(`UPDATE queue_item SET status='sending',dispatch_generation=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=? AND status IN ('queued','retrying') AND NOT EXISTS (
        SELECT 1 FROM queue_item active_item JOIN queue_attempt active_attempt ON active_attempt.queue_item_id=active_item.queue_item_id
        WHERE active_item.scope_id=? AND active_item.queue_item_id<>? AND (active_item.status IN ('sending','reconciling') OR (active_attempt.lease_token IS NOT NULL AND active_attempt.lease_expires_at>? AND active_attempt.lease_generation=?))
      )`).run(authority.generation, timestamp, row.queue_item_id, row.scope_id, row.queue_item_id, timestamp, authority.generation);
      if (!updated.changes) return { value: null, scopeIDs: [] };
      db.prepare('UPDATE queue_attempt SET lease_owner=?,lease_token=?,lease_expires_at=?,lease_generation=?,fence_generation=?,reconciliation_state=NULL WHERE queue_item_id=?').run(owner, token, expires, authority.generation, authority.generation, row.queue_item_id);
      return { scopeIDs: [row.scope_id], value: { item: itemOutput(itemRow(row.queue_item_id)), leaseToken: token, leaseExpiresAt: expires, fenceGeneration: authority.generation, dispatchMode: row.manual_dispatch_requested ? 'manual' : 'automatic' } };
    });
  };
  const leaseRow = (key, queueItemID, leaseToken, fenceGeneration) => db.prepare(`SELECT item.*, attempt.lease_token, attempt.fence_generation FROM queue_item AS item JOIN queue_attempt AS attempt ON attempt.queue_item_id=item.queue_item_id JOIN queue_scope AS scope ON scope.scope_id=item.scope_id JOIN queue_runtime AS runtime ON runtime.runtime_key=scope.runtime_key WHERE item.queue_item_id=? AND attempt.lease_token=? AND attempt.fence_generation=? AND attempt.lease_generation=? AND attempt.lease_expires_at>? AND item.dispatch_generation=? AND runtime.runtime_key=? AND runtime.authority='active' AND runtime.generation=? AND item.status IN ('sending','reconciling')`).get(queueItemID, leaseToken, fenceGeneration, fenceGeneration, now(), fenceGeneration, key, fenceGeneration);
  const leaseLost = () => fail('lease_lost');
  const renewLease = ({ queueItemID, leaseToken, fenceGeneration, leaseMs = 30_000, runtimeKey: override } = {}) => { const key = capturedRuntimeKey(override); return workerMutation(key, () => {
    if (!nonEmptyString(queueItemID) || !nonEmptyString(leaseToken) || !Number.isInteger(fenceGeneration) || !Number.isSafeInteger(leaseMs) || leaseMs < 1) fail('validation_error'); const row = leaseRow(key, queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const expires = now() + leaseMs;
    if (!db.prepare('UPDATE queue_attempt SET lease_expires_at=? WHERE queue_item_id=? AND lease_token=? AND fence_generation=?').run(expires, queueItemID, leaseToken, fenceGeneration).changes) leaseLost(); return { scopeIDs: [row.scope_id], value: { queueItemID, leaseExpiresAt: expires } };
  }); };
  const beginAttempt = ({ queueItemID, leaseToken, fenceGeneration, messageID, runtimeKey: override } = {}) => { const key = capturedRuntimeKey(override); return workerMutation(key, () => {
    if (!nonEmptyString(messageID) || !messageID.startsWith('msg_')) fail('validation_error'); const row = leaseRow(key, queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(queueItemID); const count = attempt.attempt_count + 1;
    db.prepare('UPDATE queue_attempt SET message_id=?,attempt_count=?,last_attempt_at=? WHERE queue_item_id=? AND lease_token=? AND fence_generation=?').run(messageID, count, now(), queueItemID, leaseToken, fenceGeneration);
    db.prepare('UPDATE queue_item SET manual_dispatch_requested=0 WHERE queue_item_id=?').run(queueItemID);
    db.prepare('INSERT INTO queue_attempt_history(attempt_id,queue_item_id,operation_id,message_id,attempt_number,lease_owner,lease_token,fence_generation,started_at) VALUES (?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), queueItemID, row.operation_id, messageID, count, attempt.lease_owner, leaseToken, fenceGeneration, now());
    return { scopeIDs: [row.scope_id], value: { queueItemID, messageID, attemptCount: count, fenceGeneration } };
  }); };
  const releaseIneligible = ({ queueItemID, leaseToken, fenceGeneration, dueAt = now(), runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    const row = leaseRow(capturedRuntimeKey(override), queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); db.prepare("UPDATE queue_item SET status='queued',due_at=?,dispatch_generation=NULL,row_version=row_version+1,updated_at=? WHERE queue_item_id=?").run(dueAt, now(), queueItemID); db.prepare('UPDATE queue_attempt SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id=?').run(queueItemID); return { scopeIDs: [row.scope_id], value: { queueItemID } };
  });
  const scheduleRetry = ({ queueItemID, leaseToken, fenceGeneration, dueAt, errorCode, runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    if (!Number.isSafeInteger(dueAt) || dueAt < now()) fail('validation_error'); const row = leaseRow(capturedRuntimeKey(override), queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); db.prepare("UPDATE queue_item SET status='retrying',due_at=?,last_error_code=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=?").run(dueAt, errorCode ?? null, now(), queueItemID); db.prepare('UPDATE queue_attempt SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=? WHERE queue_item_id=?').run(errorCode ?? null, queueItemID); db.prepare("UPDATE queue_attempt_history SET finished_at=?,outcome='retrying',error_code=? WHERE queue_item_id=? AND message_id=(SELECT message_id FROM queue_attempt WHERE queue_item_id=?) AND finished_at IS NULL").run(now(), errorCode ?? null, queueItemID, queueItemID); return { scopeIDs: [row.scope_id], value: { queueItemID, dueAt } };
  });
  const markWorkerState = (state, { queueItemID, leaseToken, fenceGeneration, errorCode, dueAt = now(), runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    const row = leaseRow(capturedRuntimeKey(override), queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const reconciling = state === 'reconciling'; const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(queueItemID); const startedAt = attempt.reconciliation_started_at ?? now(); const deadline = attempt.reconciliation_deadline_at ?? startedAt + 30_000;
    db.prepare('UPDATE queue_item SET status=?,reconciliation_due_at=?,manual_dispatch_requested=?,last_error_code=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=?').run(state, reconciling ? dueAt : null, reconciling ? 0 : row.manual_dispatch_requested, errorCode ?? null, now(), queueItemID);
    db.prepare('UPDATE queue_attempt SET reconciliation_state=?,reconciliation_started_at=?,reconciliation_deadline_at=?,reconciliation_next_check_at=?,reconciled_at=?,last_error_code=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id=?').run(reconciling ? state : null, reconciling ? startedAt : null, reconciling ? deadline : null, reconciling ? dueAt : null, reconciling ? null : now(), errorCode ?? null, queueItemID); return { scopeIDs: [row.scope_id], value: { queueItemID, status: state } };
  });
  const markAmbiguous = (input) => markWorkerState('reconciling', input);
  const recordReconcileUnavailable = ({ queueItemID, leaseToken, fenceGeneration, runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    const key = capturedRuntimeKey(override); const row = leaseRow(key, queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(queueItemID); const startedAt = attempt.reconciliation_started_at ?? now(); const deadline = attempt.reconciliation_deadline_at ?? startedAt + 30_000; const unavailableChecks = (attempt.reconciliation_unavailable_checks ?? 0) + 1; const expired = now() >= deadline; const delay = Math.min(10_000, 1_000 * 2 ** Math.min(4, unavailableChecks - 1)); const dueAt = Math.min(deadline, now() + delay);
    db.prepare('UPDATE queue_item SET status=?,reconciliation_due_at=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=?').run(expired ? 'unresolved' : 'reconciling', expired ? null : dueAt, now(), queueItemID);
    db.prepare('UPDATE queue_attempt SET reconciliation_state=?,reconciliation_started_at=?,reconciliation_deadline_at=?,reconciliation_unavailable_checks=?,reconciliation_next_check_at=?,reconciled_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id=?').run(expired ? 'unresolved' : 'reconciling', startedAt, deadline, unavailableChecks, expired ? null : dueAt, expired ? now() : null, queueItemID);
    return { scopeIDs: [row.scope_id], value: { queueItemID, status: expired ? 'unresolved' : 'reconciling', deadlineAt: deadline } };
  });
  const recordReconcileMiss = ({ queueItemID, leaseToken, fenceGeneration, runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    const row = leaseRow(capturedRuntimeKey(override), queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(queueItemID); const startedAt = attempt.reconciliation_started_at ?? now(); const checks = attempt.reconciliation_checks + 1; const deadline = attempt.reconciliation_deadline_at ?? startedAt + 30_000; const unresolved = checks >= 3 || now() >= deadline; const next = Math.min(deadline, now() + 10_000);
    db.prepare('UPDATE queue_attempt SET reconciliation_started_at=?,reconciliation_deadline_at=?,reconciliation_checks=?,reconciliation_next_check_at=?,reconciliation_state=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id=?').run(startedAt,deadline,checks,unresolved ? null : next,unresolved ? 'unresolved' : 'reconciling',queueItemID);
    db.prepare('UPDATE queue_item SET status=?,reconciliation_due_at=?,row_version=row_version+1,updated_at=? WHERE queue_item_id=?').run(unresolved ? 'unresolved' : 'reconciling',unresolved ? null : next,now(),queueItemID);
    return { scopeIDs: [row.scope_id], value: { queueItemID, checks, startedAt, deadlineAt: deadline, status: unresolved ? 'unresolved' : 'reconciling' } };
  });
  const recordReconcileConfirmed = (input) => completeAttempt(input);
  const markFailed = (input) => markWorkerState('failed', input);
  const markUnresolved = (input) => markWorkerState('unresolved', input);
  const listDueReconcile = ({ limit = 64, runtimeKey: override } = {}) => { const key = capturedRuntimeKey(override); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) fail('validation_error'); return db.prepare(`SELECT item.*,attempt.lease_token,attempt.fence_generation,attempt.reconciliation_checks,attempt.reconciliation_started_at FROM queue_item item JOIN queue_scope scope ON scope.scope_id=item.scope_id JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id WHERE scope.runtime_key=? AND item.status='reconciling' AND COALESCE(item.reconciliation_due_at,0)<=? ORDER BY item.reconciliation_due_at,item.created_at LIMIT ?`).all(key, now(), limit).map((row) => ({ ...itemOutput(row), leaseToken: row.lease_token, fenceGeneration: row.fence_generation, checks: row.reconciliation_checks, startedAt: row.reconciliation_started_at })); };
  const claimDueReconcile = ({ owner, leaseMs = 30_000, runtimeKey: override } = {}) => {
    const key = capturedRuntimeKey(override); if (!nonEmptyString(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) fail('validation_error');
    return workerMutation(key, () => {
      const authority = authorityRow(key); if (authority.authority !== 'active') return { value: null, scopeIDs: [] };
      const row = db.prepare(`SELECT item.* FROM queue_item item JOIN queue_scope scope ON scope.scope_id=item.scope_id JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id WHERE scope.runtime_key=? AND item.status='reconciling' AND COALESCE(item.reconciliation_due_at,0)<=? AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at<=?) ORDER BY item.reconciliation_due_at,item.created_at LIMIT 1`).get(key, now(), now());
      if (!row) return { value: null, scopeIDs: [] }; const token = crypto.randomUUID(); const expires = now() + leaseMs;
      const claimed = db.prepare("UPDATE queue_attempt SET lease_owner=?,lease_token=?,lease_expires_at=?,lease_generation=?,fence_generation=? WHERE queue_item_id=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)").run(owner, token, expires, authority.generation, authority.generation, row.queue_item_id, now());
      if (!claimed.changes) return { value: null, scopeIDs: [] };
      db.prepare('UPDATE queue_item SET dispatch_generation=?,updated_at=? WHERE queue_item_id=?').run(authority.generation, now(), row.queue_item_id);
      return { scopeIDs: [row.scope_id], value: { item: itemOutput(itemRow(row.queue_item_id)), leaseToken: token, leaseExpiresAt: expires, fenceGeneration: authority.generation } };
    });
  };
  const completeAttempt = ({ queueItemID, operationID, messageID, leaseToken, fenceGeneration, completion = {}, source = 'worker', runtimeKey: override } = {}) => workerMutation(capturedRuntimeKey(override), () => {
    const existing = completedIdentity({ queueItemID, operationID, messageID }); if (existing) return { scopeIDs: [], value: { queueItemID: existing.queue_item_id, operationID: existing.operation_id, messageID: existing.message_id, completed: true, duplicate: true } };
    const row = leaseRow(capturedRuntimeKey(override), queueItemID, leaseToken, fenceGeneration); if (!row) leaseLost(); const attempt = db.prepare('SELECT * FROM queue_attempt WHERE queue_item_id=?').get(queueItemID);
    if (row.operation_id !== operationID || attempt.message_id !== messageID) fail('idempotency_conflict');
    db.prepare('INSERT INTO queue_completion(operation_id,message_id,queue_item_id,runtime_key,source,attempt_number,completed_at,completion_json) VALUES (?,?,?,?,?,?,?,?)').run(row.operation_id, attempt.message_id, queueItemID, capturedRuntimeKey(override), source, attempt.attempt_count, now(), JSON.stringify(completion)); db.prepare("UPDATE queue_attempt_history SET finished_at=?,outcome='completed' WHERE queue_item_id=? AND message_id=? AND finished_at IS NULL").run(now(), queueItemID, attempt.message_id); db.prepare('DELETE FROM queue_item WHERE queue_item_id=?').run(queueItemID); return { scopeIDs: [row.scope_id], value: { queueItemID, operationID: row.operation_id, messageID: attempt.message_id, completed: true } };
  });
  const confirmByMessage = ({ runtimeKey: override, directory, sessionID, messageID, source = 'event' } = {}) => {
    const key = capturedRuntimeKey(override); if (!normalizeDirectory(directory) || !nonEmptyString(sessionID) || !nonEmptyString(messageID)) fail('validation_error');
    return workerMutation(key, () => {
      const row = db.prepare(`SELECT item.*, attempt.attempt_count FROM queue_item item JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id JOIN queue_scope scope ON scope.scope_id=item.scope_id WHERE scope.runtime_key=? AND scope.directory=? AND scope.session_id=? AND attempt.message_id=?`).get(key, normalizeDirectory(directory), sessionID, messageID);
      const duplicate = db.prepare('SELECT * FROM queue_completion WHERE runtime_key=? AND message_id=?').get(key, messageID);
      if (duplicate) {
        if (row) completedIdentity({ queueItemID: row.queue_item_id, operationID: row.operation_id, messageID });
        return { scopeIDs: [], value: { queueItemID: duplicate.queue_item_id, operationID: duplicate.operation_id, messageID: duplicate.message_id, completed: true, duplicate: true } };
      }
      if (!row) return { scopeIDs: [], value: { completed: false } };
      db.prepare('INSERT INTO queue_completion(operation_id,message_id,queue_item_id,runtime_key,source,attempt_number,completed_at,completion_json) VALUES (?,?,?,?,?,?,?,?)').run(row.operation_id,messageID,row.queue_item_id,key,source,row.attempt_count,now(),'{}');
      db.prepare("UPDATE queue_attempt_history SET finished_at=?,outcome='completed' WHERE queue_item_id=? AND message_id=? AND finished_at IS NULL").run(now(),row.queue_item_id,messageID);
      db.prepare('DELETE FROM queue_item WHERE queue_item_id=?').run(row.queue_item_id);
      return { scopeIDs: [row.scope_id], value: { queueItemID: row.queue_item_id, operationID: row.operation_id, messageID, completed: true } };
    });
  };
  const createAttachmentUpload = ({ expiresAt } = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey); const expiry = expiresAt ?? now() + 60 * 60 * 1000; if (!Number.isSafeInteger(expiry) || expiry <= now()) fail('validation_error'); const uploadID = crypto.randomUUID(); const uploadToken = crypto.randomUUID(); db.prepare("INSERT INTO attachment_upload(upload_id,runtime_key,state,upload_token,expires_at,created_at) VALUES (?,?,'staging',?,?,?)").run(uploadID, key, uploadToken, expiry, now()); return { uploadID, uploadToken, expiresAt: expiry };
  };
  const markAttachmentReady = ({ uploadID, uploadToken, objectHash, storageKey, sizeBytes } = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey); if (!nonEmptyString(uploadID) || !nonEmptyString(uploadToken) || !nonEmptyString(objectHash) || !nonEmptyString(storageKey, MAX_PATH) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ATTACHMENT_BYTES) fail('validation_error'); let changed = false; db.exec('BEGIN IMMEDIATE'); try { const upload = db.prepare("SELECT * FROM attachment_upload WHERE upload_id=? AND runtime_key=? AND upload_token=? AND state='staging' AND expires_at>=?").get(uploadID,key,uploadToken,now()); if (!upload) fail('attachment_unavailable'); db.prepare('INSERT INTO attachment_object(object_hash,storage_key,size_bytes,created_at,last_referenced_at) VALUES (?,?,?,?,?) ON CONFLICT(object_hash) DO UPDATE SET last_referenced_at=excluded.last_referenced_at').run(objectHash,storageKey,sizeBytes,now(),now()); if (!db.prepare("UPDATE attachment_upload SET state='ready',object_hash=?,storage_key=?,size_bytes=?,ready_at=? WHERE upload_id=? AND state='staging'").run(objectHash,storageKey,sizeBytes,now(),uploadID).changes) fail('attachment_unavailable'); db.exec('COMMIT'); changed=true; return { uploadID, state: 'ready', objectHash, storageKey, sizeBytes }; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { if (changed) publish(); }
  };
  const getAttachmentUpload = ({ uploadID, uploadToken } = {}, options = {}) => {
    const key = capturedRuntimeKey(options.runtimeKey);
    if (!nonEmptyString(uploadID) || !nonEmptyString(uploadToken)) fail('validation_error');
    const row = db.prepare('SELECT upload_id,state,expires_at FROM attachment_upload WHERE upload_id=? AND runtime_key=? AND upload_token=?').get(uploadID, key, uploadToken);
    if (!row || row.expires_at < now()) fail('attachment_unavailable');
    return { uploadID: row.upload_id, state: row.state, expiresAt: row.expires_at };
  };
  const expireAttachmentUploads = (options = {}) => { const key = capturedRuntimeKey(options.runtimeKey); return db.prepare("UPDATE attachment_upload SET state='expired' WHERE runtime_key=? AND state IN ('staging','ready') AND expires_at<?").run(key, now()).changes; };
  const expireAttachmentUploadsAll = () => db.prepare("UPDATE attachment_upload SET state='expired' WHERE state IN ('staging','ready') AND expires_at<?").run(now()).changes;
  const listAttachmentObjectsForGC = ({ limit = 256 } = {}) => db.prepare("SELECT object.* FROM attachment_object object WHERE NOT EXISTS (SELECT 1 FROM queue_attachment attachment WHERE attachment.object_hash=object.object_hash) AND NOT EXISTS (SELECT 1 FROM attachment_upload upload WHERE upload.object_hash=object.object_hash AND upload.state='ready' AND upload.expires_at>=?) ORDER BY object.last_referenced_at LIMIT ?").all(now(), limit).map((row) => ({ objectHash: row.object_hash, storageKey: row.storage_key, sizeBytes: row.size_bytes, lastReferencedAt: row.last_referenced_at }));
  const listLiveAttachmentStorageKeys = () => new Set(db.prepare(`SELECT DISTINCT object.storage_key FROM attachment_object object WHERE EXISTS (SELECT 1 FROM queue_attachment attachment WHERE attachment.object_hash=object.object_hash) OR EXISTS (SELECT 1 FROM attachment_upload upload WHERE upload.object_hash=object.object_hash AND upload.state='ready' AND upload.expires_at>=?)`).all(now()).map((row) => row.storage_key));
  const isAttachmentStorageKeyLive = (storageKey) => Boolean(db.prepare(`SELECT 1 FROM attachment_object object WHERE object.storage_key=? AND (EXISTS (SELECT 1 FROM queue_attachment attachment WHERE attachment.object_hash=object.object_hash) OR EXISTS (SELECT 1 FROM attachment_upload upload WHERE upload.object_hash=object.object_hash AND upload.state='ready' AND upload.expires_at>=?))`).get(storageKey, now()));
  const removeAttachmentObjectForGC = ({ objectHash, storageKey } = {}) => { if (!nonEmptyString(objectHash) || !nonEmptyString(storageKey, MAX_PATH)) fail('validation_error'); return db.prepare("DELETE FROM attachment_object WHERE object_hash=? AND storage_key=? AND NOT EXISTS (SELECT 1 FROM queue_attachment WHERE queue_attachment.object_hash=attachment_object.object_hash) AND NOT EXISTS (SELECT 1 FROM attachment_upload WHERE attachment_upload.object_hash=attachment_object.object_hash AND attachment_upload.state='ready' AND attachment_upload.expires_at>=?)").run(objectHash, storageKey, now()).changes; };
  const importManifest = (rows) => hashCanonical(canonical(rows.map((row) => ({ scopeOrdinal: row.scope_ordinal, itemOrdinal: row.item_ordinal, payloadHash: row.payload_hash }))));
  const importRow = (importID, key) => db.prepare('SELECT * FROM queue_import WHERE import_id=? AND runtime_key=?').get(importID, key);
  const importCommit = (row) => ({ revision: row.commit_revision, importID: row.import_id, manifestHash: row.commit_manifest_hash, generation: row.commit_generation, activationEpoch: row.commit_activation_epoch, added: row.commit_added });
  const importDetails = (imported) => ({ state: imported.state, manifestHash: imported.manifest_hash ?? undefined, itemCount: imported.item_count, ...(imported.state === 'committed' ? { commit: importCommit(imported) } : {}), staged: db.prepare('SELECT scope_ordinal AS scopeOrdinal,item_ordinal AS itemOrdinal,payload_hash AS payloadHash FROM queue_import_item WHERE import_id=? ORDER BY scope_ordinal,item_ordinal').all(imported.import_id) });
  const validateImportCreate = (input) => {
    if (!plainObject(input) || Object.keys(input).some((key) => !['requestID', 'kind', 'clientID', 'snapshotHash', 'itemCount', 'protocol', 'expectedGeneration'].includes(key)) || !['activation', 'late'].includes(input.kind) || !nonEmptyString(input.clientID) || !/^[a-f0-9]{64}$/.test(input.snapshotHash ?? '') || !Number.isSafeInteger(input.itemCount) || input.itemCount < 0 || input.itemCount > MAX_ITEMS || input.protocol !== 4 || !Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 0) fail('validation_error');
  };
  const createImport = (input) => importTransaction(input?.requestID, input, 'queue:import:create', (key) => {
    validateImportCreate(input); const authority = authorityRow(key); if (authority.generation !== input.expectedGeneration) fail('generation_conflict');
    db.prepare("UPDATE queue_import SET state='expired' WHERE runtime_key=? AND state IN ('staging','sealed') AND expires_at<?").run(key, now());
    const existing = db.prepare("SELECT * FROM queue_import WHERE runtime_key=? AND kind=? AND client_id=? AND snapshot_hash=? AND state IN ('staging','sealed','committed')").get(key, input.kind, input.clientID, input.snapshotHash);
    if (existing) return { revision: globalRevision(), importID: existing.import_id, state: existing.state, duplicate: true, ...(existing.state === 'committed' ? { manifestHash: existing.commit_manifest_hash, commit: importCommit(existing) } : {}) };
    const importID = crypto.randomUUID(); db.prepare("INSERT INTO queue_import(import_id,runtime_key,kind,client_id,snapshot_hash,item_count,protocol,expected_generation,state,created_at,expires_at) VALUES (?,?,?,?,?,?,? ,?,'staging',?,?)").run(importID,key,input.kind,input.clientID,input.snapshotHash,input.itemCount,input.protocol,input.expectedGeneration,now(),now()+60*60*1000);
    return { revision: globalRevision(), importID, state: 'staging' };
  });
  const stageImport = (input) => importTransaction(input?.requestID, input, 'queue:import:stage', (key) => {
    if (!plainObject(input) || Object.keys(input).some((entry) => !['requestID','importID','scopeOrdinal','itemOrdinal','payload','payloadHash'].includes(entry)) || !nonEmptyString(input.importID) || !Number.isSafeInteger(input.scopeOrdinal) || input.scopeOrdinal < 0 || !Number.isSafeInteger(input.itemOrdinal) || input.itemOrdinal < 0 || !plainObject(input.payload)) fail('validation_error');
    const imported = importRow(input.importID, key); if (!imported || imported.expires_at < now()) fail('not_found');
    if (imported.state === 'sealed') { const existing = db.prepare('SELECT * FROM queue_import_item WHERE import_id=? AND scope_ordinal=? AND item_ordinal=?').get(input.importID,input.scopeOrdinal,input.itemOrdinal); if (!existing) fail('validation_error'); const payloadHash = hashCanonical(canonical(input.payload)); if (existing.payload_hash !== payloadHash) fail('idempotency_conflict'); return { revision: globalRevision(), importID: input.importID, staged: true, duplicate: true }; }
    if (imported.state !== 'staging') fail('not_found');
    const payloadText = canonical(input.payload); if (!payloadText) fail('validation_error'); const payloadHash = hashCanonical(payloadText); if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) fail('validation_error');
    const payload = JSON.parse(payloadText); validateAdmission({ requestID: 'import-validation', scope: payload.scope, item: payload.item });
    const item = payload.item; const existing = db.prepare('SELECT * FROM queue_import_item WHERE import_id=? AND scope_ordinal=? AND item_ordinal=?').get(input.importID,input.scopeOrdinal,input.itemOrdinal);
    if (existing) { if (existing.payload_hash !== payloadHash) fail('idempotency_conflict'); return { revision: globalRevision(), importID: input.importID, staged: true, duplicate: true }; }
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM queue_import_item WHERE import_id=?').get(input.importID).count) >= imported.item_count) fail('validation_error');
    db.prepare('INSERT INTO queue_import_item(import_id,scope_ordinal,item_ordinal,queue_item_id,operation_id,message_id,payload_json,payload_hash) VALUES (?,?,?,?,?,?,?,?)').run(input.importID,input.scopeOrdinal,input.itemOrdinal,item.queueItemID,item.operationID,item.messageID,payloadText,payloadHash);
    return { revision: globalRevision(), importID: input.importID, staged: true };
  });
  const sealImport = (input) => importTransaction(input?.requestID, input, 'queue:import:seal', (key) => {
    if (!plainObject(input) || Object.keys(input).some((entry) => !['requestID','importID'].includes(entry)) || !nonEmptyString(input.importID)) fail('validation_error'); const imported = importRow(input.importID,key); if (!imported || imported.expires_at < now()) fail('not_found'); if (imported.state === 'sealed') return { revision: globalRevision(), importID: input.importID, manifestHash: imported.manifest_hash, state: 'sealed', itemCount: imported.item_count }; if (imported.state !== 'staging') fail('not_found');
    const rows = db.prepare('SELECT * FROM queue_import_item WHERE import_id=? ORDER BY scope_ordinal,item_ordinal').all(input.importID); if (rows.length !== imported.item_count) fail('validation_error'); const manifestHash = importManifest(rows);
    const ordinalRows = rows.map((row) => `${row.scope_ordinal}:${row.item_ordinal}`); const scopes = [...new Set(rows.map((row) => row.scope_ordinal))];
    if (scopes.some((scope, index) => scope !== index) || scopes.some((scope) => rows.filter((row) => row.scope_ordinal === scope).some((row, index) => row.item_ordinal !== index))) fail('validation_error');
    db.prepare("UPDATE queue_import SET state='sealed',manifest_hash=?,sealed_at=? WHERE import_id=?").run(manifestHash,now(),input.importID); return { revision: globalRevision(), importID: input.importID, manifestHash, state: 'sealed', itemCount: ordinalRows.length };
  });
  const abandonImport = (input) => importTransaction(input?.requestID, input, 'queue:import:abandon', (key) => {
    if (!plainObject(input) || Object.keys(input).some((entry) => !['requestID','importID'].includes(entry)) || !nonEmptyString(input.importID)) fail('validation_error'); const imported=importRow(input.importID,key); if (!imported) fail('not_found'); db.prepare("UPDATE queue_import SET state='abandoned' WHERE import_id=? AND state IN ('staging','sealed')").run(input.importID); return { revision: globalRevision(), importID: input.importID, state: 'abandoned' };
  });
  const commitImport = (input, kind) => transaction(input?.requestID, input, `queue:import:${kind}`, (revision, key) => {
    if (!plainObject(input) || Object.keys(input).some((entry) => !['requestID','importID','expectedGeneration','manifestHash','protocol'].includes(entry)) || !nonEmptyString(input.importID) || !Number.isInteger(input.expectedGeneration) || input.protocol !== 4 || !/^[a-f0-9]{64}$/.test(input.manifestHash ?? '')) fail('validation_error');
    const imported=importRow(input.importID,key); if (!imported || imported.kind !== kind) fail('not_found'); if (imported.state === 'committed') return importCommit(imported); const authority=authorityRow(key); if (imported.state !== 'sealed' || imported.expires_at < now()) fail('not_found'); if (imported.manifest_hash !== input.manifestHash || imported.expected_generation !== input.expectedGeneration || authority.generation !== input.expectedGeneration) fail('generation_conflict');
    if ((kind === 'activation' && authority.authority !== 'shadow') || (kind === 'late' && !['active','paused'].includes(authority.authority))) fail('authority_conflict');
    const rows=db.prepare('SELECT * FROM queue_import_item WHERE import_id=? ORDER BY scope_ordinal,item_ordinal').all(input.importID); if (rows.length !== imported.item_count || importManifest(rows) !== imported.manifest_hash) fail('validation_error');
    const additions=[]; for (const staged of rows) { const payload=JSON.parse(staged.payload_json); validateAdmission({ requestID:'import-validation',scope:payload.scope,item:payload.item }); const item=payload.item; const active=db.prepare('SELECT item.*,attempt.message_id FROM queue_item item JOIN queue_attempt attempt ON attempt.queue_item_id=item.queue_item_id JOIN queue_scope scope ON scope.scope_id=item.scope_id WHERE scope.runtime_key=? AND (item.queue_item_id=? OR item.operation_id=? OR attempt.message_id=?)').all(key,item.queueItemID,item.operationID,item.messageID); const complete=db.prepare('SELECT * FROM queue_completion WHERE runtime_key=? AND (queue_item_id=? OR operation_id=? OR message_id=?)').all(key,item.queueItemID,item.operationID,item.messageID); const exactActive=active.length && active.every((row)=>row.queue_item_id===item.queueItemID&&row.operation_id===item.operationID); const exactComplete=complete.length && complete.every((row)=>row.queue_item_id===item.queueItemID&&row.operation_id===item.operationID); if (active.length || complete.length) { if (exactActive || exactComplete) continue; fail('idempotency_conflict'); } additions.push({ payload, item }); }
    const currentItems=Number(db.prepare('SELECT COUNT(*) AS count FROM queue_item item JOIN queue_scope scope ON scope.scope_id=item.scope_id WHERE scope.runtime_key=?').get(key).count); if (currentItems + additions.length > MAX_ITEMS) fail('validation_error');
    const touched=[]; let added=0; for (const { payload, item } of additions) { const scope=ensureScope(payload.scope,key);
      const position=db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM queue_item WHERE scope_id=?').get(scope.scope_id).position; const importedState=item.migrationState; const status=item.migrationImport && item.attachmentIssues.length ? 'unresolved' : ['sending','reconciling'].includes(importedState?.status) ? 'reconciling' : importedState?.status ?? 'queued'; const reconcile=status === 'reconciling'; db.prepare('INSERT INTO queue_item(queue_item_id,operation_id,scope_id,content,composer_document,send_config,position,status,row_version,created_at,updated_at,due_at,reconciliation_due_at,last_error_code,attachment_issues) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)').run(item.queueItemID,item.operationID,scope.scope_id,item.content,optionalJson(item.composerDocument),optionalJson(item.sendConfig),position,status,item.createdAt,now(),importedState?.dueAt ?? item.dueAt ?? now(),reconcile ? (importedState?.reconciliationNextCheckAt ?? now()) : null,importedState?.failureKind ?? null,JSON.stringify(item.attachmentIssues)); db.prepare('INSERT INTO queue_attempt(queue_item_id,message_id,attempt_count,reconciliation_state,reconciliation_started_at,reconciliation_deadline_at,reconciliation_checks,reconciliation_next_check_at,last_error_code) VALUES (?,?,?,?,?,?,?,?,?)').run(item.queueItemID,item.messageID,importedState?.attemptCount??0,reconcile ? 'reconciling' : null,reconcile ? (importedState?.reconciliationStartedAt ?? now()) : null,reconcile ? (importedState?.reconciliationDeadlineAt ?? now()+30_000) : null,importedState?.reconciliationChecks??0,reconcile ? (importedState?.reconciliationNextCheckAt ?? now()) : null,importedState?.failureKind??null); bindAttachments(item.queueItemID,validateAttachments(item),key,scope); touched.push(scope.scope_id); added++; }
    const generation=kind==='activation' ? authority.generation+1 : authority.generation; const epoch=kind==='activation' ? authority.activation_epoch+1 : authority.activation_epoch; if (kind==='activation') db.prepare("INSERT INTO queue_runtime(runtime_key,authority,generation,activation_epoch,activated_at,manifest_hash,protocol,updated_at) VALUES (?,?,?,?,?,?,4,?) ON CONFLICT(runtime_key) DO UPDATE SET authority=excluded.authority,generation=excluded.generation,activation_epoch=excluded.activation_epoch,activated_at=COALESCE(queue_runtime.activated_at,excluded.activated_at),manifest_hash=excluded.manifest_hash,protocol=4,updated_at=excluded.updated_at").run(key,'active',generation,epoch,now(),imported.manifest_hash,now()); db.prepare("UPDATE queue_import SET state='committed',committed_at=?,commit_generation=?,commit_activation_epoch=?,commit_added=?,commit_manifest_hash=?,commit_revision=? WHERE import_id=?").run(now(),generation,epoch,added,imported.manifest_hash,revision,input.importID); touchScopes([...new Set(touched)],revision); return { revision, importID:input.importID, manifestHash:imported.manifest_hash, generation, activationEpoch:epoch, added };
  });
  const activateImport = (input) => commitImport(input, 'activation');
  const commitLateImport = (input) => commitImport(input, 'late');
  const pauseAuthority = ({ expectedGeneration } = {}) => { const key=runtimeKey(); if (!Number.isInteger(expectedGeneration)) fail('validation_error'); let changed=false; db.exec('BEGIN IMMEDIATE'); try { const current=authorityRow(key); if (current.authority !== 'active' || current.generation !== expectedGeneration) fail('generation_conflict'); const rows=db.prepare("SELECT item.queue_item_id,item.scope_id FROM queue_item item JOIN queue_scope scope ON scope.scope_id=item.scope_id WHERE scope.runtime_key=? AND item.status='sending'").all(key); const ids=rows.map((row)=>row.queue_item_id); if (ids.length) { const marks=ids.map(()=>'?').join(','); db.prepare(`UPDATE queue_item SET status='reconciling',reconciliation_due_at=?,manual_dispatch_requested=0,row_version=row_version+1,updated_at=? WHERE queue_item_id IN (${marks})`).run(now(),now(),...ids); db.prepare(`UPDATE queue_attempt SET reconciliation_state='reconciling',reconciliation_started_at=COALESCE(reconciliation_started_at,?),reconciliation_deadline_at=COALESCE(reconciliation_deadline_at,?),reconciliation_next_check_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE queue_item_id IN (${marks})`).run(now(),now()+30_000,now(),...ids); } const generation=current.generation+1; db.prepare("UPDATE queue_runtime SET authority='paused',generation=?,updated_at=? WHERE runtime_key=?").run(generation,now(),key); const revision=globalRevision()+1; touchScopes(rows.map((row)=>row.scope_id),revision); setGlobalRevision(revision); db.exec('COMMIT'); changed=true; return { authority:'paused',generation,revision }; } catch(error){db.exec('ROLLBACK');throw error;} finally {if(changed)publish();} };
  const resumeAuthority = ({ expectedGeneration } = {}) => { const key=runtimeKey(); if (!Number.isInteger(expectedGeneration)) fail('validation_error'); let changed=false; db.exec('BEGIN IMMEDIATE'); try { const current=authorityRow(key); if (current.authority !== 'paused' || current.generation !== expectedGeneration) fail('generation_conflict'); const generation=current.generation+1; db.prepare("UPDATE queue_runtime SET authority='active',generation=?,updated_at=? WHERE runtime_key=?").run(generation,now(),key); const revision=globalRevision()+1; setGlobalRevision(revision); db.exec('COMMIT'); changed=true; return { authority:'active',generation,revision }; } catch(error){db.exec('ROLLBACK');throw error;} finally {if(changed)publish();} };
  const waitForChange = (afterRevision, { timeoutMs = 25_000, signal } = {}) => new Promise((resolve) => {
    const after = Number.isInteger(afterRevision) && afterRevision >= 0 ? afterRevision : 0; const timeout = Number.isInteger(timeoutMs) && timeoutMs >= 0 ? Math.min(timeoutMs, 25_000) : 25_000;
    if (closed || globalRevision() > after) return resolve(changesSnapshot()); let timer; const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener('abort', done); resolve(changesSnapshot()); }; timer = setTimeout(done, timeout); waiters.add(done); signal?.addEventListener('abort', done, { once: true });
  });
  const getItemAttachment = (queueItemID, attachmentID, options = {}) => {
    if (!nonEmptyString(queueItemID) || !nonEmptyString(attachmentID)) fail('validation_error');
    const row = itemRow(queueItemID); if (!row) fail('not_found'); const scope = scopeRow(row.scope_id); const key = capturedRuntimeKey(options.runtimeKey);
    if (!scope || scope.runtime_key !== key) fail('not_found'); const attachment = attachmentsFor(queueItemID).find((entry) => entry.attachmentID === attachmentID);
    if (!attachment) fail('not_found'); return { attachment, item: { runtimeKey: key, directory: scope.directory } };
  };
  const close = () => { if (closed) return; closed = true; for (const waiter of [...waiters]) waiter(); db.close(); };
  try { clearExpiredReceipts(); normalizeInterruptedSending(); } catch (error) { db.close(); throw error; }
  const getImportDetails = (importID, options = {}) => { const imported = importRow(importID, capturedRuntimeKey(options.runtimeKey)); if (!imported) fail('not_found'); return importDetails(imported); };
  return { snapshot, changesSnapshot, getScope, getItemAttachment, admit, edit, remove, reservedRemove, manualSend, reserveForEdit, releaseEditReservation, renewEditReservation, reorder, waitForChange, getWorktreeOrder, getWorktreeLifecycle, setWorktreeOrder, prepareWorktreeDeletion: (input, options) => lifecycleMutation(input, 'deleting', options), commitWorktreeDeletion: (input, options) => lifecycleMutation(input, 'deleted', options), rollbackWorktreeDeletion: (input, options) => lifecycleMutation(input, 'active', options), markWorktreeActive, getAuthority, getQueueAuthority: getAuthority, setAuthority, setQueueAuthority: setAuthority, createImport, getImportDetails, stageImport, sealImport, abandonImport, activateImport, commitLateImport, pauseAuthority, resumeAuthority, recoverExpiredSending, reserveEligibilityCandidate, deferEligibilityCandidate, claimNext, claimDueReconcile, renewLease, releaseIneligible, beginAttempt, completeAttempt, confirmByMessage, scheduleRetry, markAmbiguous, recordReconcileUnavailable, recordReconcileMiss, recordReconcileConfirmed, markFailed, markUnresolved, listDueReconcile, createAttachmentUpload, getAttachmentUpload, markAttachmentReady, expireAttachmentUploads, expireAttachmentUploadsAll, listAttachmentObjectsForGC, listLiveAttachmentStorageKeys, isAttachmentStorageKeyLive, removeAttachmentObjectForGC, close, getRuntimeKey: runtimeKey };
};
