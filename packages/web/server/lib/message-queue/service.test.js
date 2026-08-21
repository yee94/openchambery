import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueService, MESSAGE_QUEUE_ADMISSION_MAX_BYTES } from './service.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const temporaryDirectories = [];
const dbPath = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'message-queue-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'queue.sqlite');
};
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

const createService = (pathname, runtime = 'http://runtime') => createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: runtime }) });
const admission = (requestID = 'request-1', suffix = '1') => ({
  requestID,
  scope: { directory: '/repo/', sessionID: 'session-1' },
  item: {
    queueItemID: `item-${suffix}`, operationID: `operation-${suffix}`, messageID: `message-${suffix}`,
    content: 'hello', composerDocument: { text: 'hello', references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' },
    attachments: [], attachmentIssues: [], createdAt: 100,
  },
});
const V1_DDL = `
  CREATE TABLE queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE worktree_lifecycle (runtime_key TEXT NOT NULL, directory TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active', 'deleting', 'deleted')), deletion_token TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (runtime_key, directory));
  CREATE TABLE queue_scope (scope_id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, directory TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), worktree_state TEXT NOT NULL CHECK(worktree_state IN ('active', 'deleting', 'deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(runtime_key, directory, session_id));
  CREATE TABLE queue_item (queue_item_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL REFERENCES queue_scope(scope_id) ON DELETE CASCADE, content TEXT NOT NULL CHECK(length(content) <= 200000), composer_document TEXT, send_config TEXT, position INTEGER NOT NULL CHECK(position >= 0), status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'retrying', 'reconciling', 'unresolved', 'failed')), row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE queue_attempt (queue_item_id TEXT PRIMARY KEY REFERENCES queue_item(queue_item_id) ON DELETE CASCADE, message_id TEXT NOT NULL UNIQUE, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), lease_owner TEXT, lease_token TEXT, lease_expires_at INTEGER, reconciliation_state TEXT, reconciled_at INTEGER, last_error_code TEXT);
  CREATE TABLE operation_receipt (runtime_key TEXT NOT NULL, request_id TEXT NOT NULL, operation_type TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, committed_revision INTEGER NOT NULL CHECK(committed_revision >= 0), created_at INTEGER NOT NULL, PRIMARY KEY (runtime_key, request_id));
  CREATE TABLE worktree_order (runtime_key TEXT NOT NULL, project_directory TEXT NOT NULL, ordered_paths TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), updated_at INTEGER NOT NULL, PRIMARY KEY(runtime_key, project_directory));
  CREATE INDEX queue_item_scope_position ON queue_item(scope_id, position, queue_item_id);
  CREATE INDEX queue_scope_runtime_directory ON queue_scope(runtime_key, directory);
`;
const createV1Fixture = (pathname, version = '1') => {
  const raw = new Database(pathname);
  raw.pragma('user_version = 1');
  raw.exec(V1_DDL);
  raw.prepare('INSERT INTO queue_meta(key,value) VALUES (?,?), (?,?)').run('schema_version', version, 'global_revision', '7');
  return raw;
};

describe('message queue service', () => {
  it('persists message attempts and replays identical receipts after restart', () => {
    const pathname = dbPath();
    const first = createService(pathname);
    const result = first.admit(admission());
    first.close();
    const reopened = createService(pathname);
    expect(reopened.getScope(result.scopeID).items[0]).toMatchObject({ messageID: 'message-1', attemptCount: 0, status: 'queued' });
    expect(reopened.admit(admission())).toEqual(result);
    expect(reopened.snapshot().revision).toBe(result.revision);
    reopened.close();
  });

  it('does not let a failed queue row block later serial work in the same scope', () => {
    const service = createService(dbPath());
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    service.admit(admission('first-request', 'first'));
    service.admit(admission('second-request', 'second'));
    const runtimeKey = service.getRuntimeKey();
    const reserved = service.reserveEligibilityCandidate({ runtimeKey, owner: 'worker', leaseMs: 15_000 });
    const claimed = service.claimNext({ runtimeKey, owner: 'worker', leaseMs: 15_000, queueItemID: reserved.item.queueItemID, eligibilityToken: reserved.eligibilityToken });
    service.beginAttempt({ runtimeKey, queueItemID: claimed.item.queueItemID, leaseToken: claimed.leaseToken, fenceGeneration: claimed.fenceGeneration, messageID: 'msg_00000000000000000000000000' });
    service.markFailed({ runtimeKey, queueItemID: claimed.item.queueItemID, leaseToken: claimed.leaseToken, fenceGeneration: claimed.fenceGeneration, errorCode: 'delivery_unknown' });

    expect(service.reserveEligibilityCandidate({ runtimeKey, owner: 'worker', leaseMs: 15_000 }).item.queueItemID).toBe('item-second');
    service.close();
  });

  it('returns the public Assistant scope-page DTO consumed by the UI fixture', () => {
    const pathname = dbPath(); const service = createService(pathname);
    service.setAssistantDeliveryService({ captureQueueDeliveryTarget: ({ assistantID, scope }) => ({ kind: 'assistant', assistantID, binding: { sessionID: scope.sessionID, directory: scope.directory, sessionGeneration: 7 }, sessionID: scope.sessionID, directory: scope.directory, sessionGeneration: 7, providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'fast', defaultPrompt: 'default', system: 'default' }) });
    const deliveryParts = [{ type: 'text', text: 'first' }, { type: 'text', text: 'last' }];
    const input = admission('assistant-request', 'assistant'); input.item.dueAt = 100; input.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; input.item.deliveryParts = deliveryParts;
    const result = service.admit(input);
    expect(service.getScope(result.scopeID)).toEqual({
      scopeID: result.scopeID, revision: result.revision, directory: '/repo', sessionID: 'session-1', worktreeState: 'active', itemCount: 1,
      items: [{ queueItemID: 'item-assistant', operationID: 'operation-assistant', messageID: 'message-assistant', content: 'hello', scopeID: result.scopeID, directory: '/repo', sessionID: 'session-1', composerDocument: { text: 'hello', references: [] }, sendConfig: { providerID: 'openai', modelID: 'gpt' }, deliveryTarget: { kind: 'assistant', assistantID: 'assistant-1' }, deliveryParts, status: 'queued', manualDispatchRequested: false, attemptCount: 0, position: 0, rowVersion: 1, createdAt: 100, dueAt: 100, attachments: [], attachmentIssues: [] }],
    });
    service.close();
    const raw = new Database(pathname); const target = JSON.parse(raw.prepare('SELECT delivery_target FROM queue_item WHERE queue_item_id=?').get('item-assistant').delivery_target); raw.close();
    expect(target).toMatchObject({ assistantID: 'assistant-1', binding: { sessionID: 'session-1', directory: '/repo/', sessionGeneration: 7 }, providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'fast', defaultPrompt: 'default', system: 'default' });
    expect(target.deliveryParts).toEqual(input.item.deliveryParts);
    const reopened = createService(pathname); const publicItem = reopened.getScope(result.scopeID).items[0]; expect(publicItem.deliveryTarget).toEqual({ kind: 'assistant', assistantID: 'assistant-1' }); expect(publicItem.deliveryParts).toEqual(deliveryParts); expect(Object.keys(publicItem.deliveryTarget)).toEqual(['kind', 'assistantID']); reopened.close();
    const primary = createService(dbPath()); const primaryResult = primary.admit(admission('primary-request', 'primary')); expect(primary.getScope(primaryResult.scopeID).items[0].deliveryTarget).toEqual({ kind: 'primary' }); primary.close();
  });

  it('rejects malformed Assistant delivery parts', () => {
    const service = createService(dbPath());
    service.setAssistantDeliveryService({ captureQueueDeliveryTarget: () => ({ kind: 'assistant', assistantID: 'assistant-1' }) });
    const missing = admission('missing-parts', 'missing'); missing.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' };
    expect(() => service.admit(missing)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const primaryParts = admission('primary-parts', 'primary-parts'); primaryParts.item.deliveryParts = [{ type: 'text', text: 'ignored' }];
    expect(() => service.admit(primaryParts)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const malformed = admission('malformed-parts', 'malformed'); malformed.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; malformed.item.deliveryParts = [{ type: 'file', mime: 'text/plain' }];
    expect(() => service.admit(malformed)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const legacyUrl = admission('legacy-url', 'legacy-url'); legacyUrl.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; legacyUrl.item.deliveryParts = [{ type: 'text', text: 'caption' }, { type: 'file', mime: 'text/plain', url: 'https://files.example/legacy' }];
    expect(() => service.admit(legacyUrl)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const maxParts = admission('max-parts', 'max-parts'); maxParts.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; maxParts.item.deliveryParts = Array.from({ length: 129 }, (_, index) => ({ type: 'text', text: String(index) }));
    expect(service.admit(maxParts)).toMatchObject({ queueItemID: 'item-max-parts' });
    const tooManyParts = admission('too-many-parts', 'too-many-parts'); tooManyParts.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; tooManyParts.item.deliveryParts = Array.from({ length: 130 }, (_, index) => ({ type: 'text', text: String(index) }));
    expect(() => service.admit(tooManyParts)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('persists Assistant synthetic edit ownership and rejects mismatched part attachments', () => {
    const pathname = dbPath(); const service = createService(pathname);
    service.setAssistantDeliveryService({ captureQueueDeliveryTarget: ({ assistantID }) => ({ kind: 'assistant', assistantID }) });
    const input = admission('synthetic', 'synthetic'); input.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' }; input.item.deliveryParts = [{ type: 'text', text: 'hello' }, { type: 'text', text: 'context', synthetic: true }]; input.item.syntheticParts = [{ partID: 'part-1', text: 'context', synthetic: true, attachmentIDs: [], deliveryPartIndexes: [1] }];
    const result = service.admit(input); service.close();
    const reopened = createService(pathname); expect(reopened.getScope(result.scopeID).items[0]).toMatchObject({ deliveryParts: input.item.deliveryParts, syntheticParts: input.item.syntheticParts }); reopened.close();
    const malformed = createService(dbPath()); malformed.setAssistantDeliveryService({ captureQueueDeliveryTarget: ({ assistantID }) => ({ kind: 'assistant', assistantID }) }); const bad = structuredClone(input); bad.requestID = 'bad'; bad.item.queueItemID = 'bad'; bad.item.operationID = 'bad'; bad.item.messageID = 'bad'; bad.item.syntheticParts[0].attachmentIDs = ['missing']; expect(() => malformed.admit(bad)).toThrow(expect.objectContaining({ code: 'validation_error' })); malformed.close();
    const mismatched = createService(dbPath()); mismatched.setAssistantDeliveryService({ captureQueueDeliveryTarget: ({ assistantID }) => ({ kind: 'assistant', assistantID }) }); const wrongIndex = structuredClone(input); wrongIndex.requestID = 'wrong-index'; wrongIndex.item.queueItemID = 'wrong-index'; wrongIndex.item.operationID = 'wrong-index'; wrongIndex.item.messageID = 'wrong-index'; wrongIndex.item.syntheticParts[0].deliveryPartIndexes = [0]; expect(() => mismatched.admit(wrongIndex)).toThrow(expect.objectContaining({ code: 'validation_error' })); mismatched.close();
  });

  it('migrates legacy targets to primary and fails malformed Assistant targets', () => {
    const pathname = dbPath(); const service = createService(pathname); const result = service.admit(admission()); service.close();
    const raw = new Database(pathname); raw.prepare("UPDATE queue_meta SET value='4' WHERE key='schema_version'").run(); raw.prepare("UPDATE queue_item SET delivery_target=? WHERE queue_item_id=?").run(JSON.stringify({ kind: 'assistant' }), 'item-1'); raw.close();
    const reopened = createService(pathname); expect(reopened.getScope(result.scopeID).items[0]).toMatchObject({ status: 'failed' }); reopened.close();
    const primaryPath = dbPath(); const primary = createService(primaryPath); const primaryResult = primary.admit(admission()); primary.close(); const primaryRaw = new Database(primaryPath); primaryRaw.prepare("UPDATE queue_meta SET value='4' WHERE key='schema_version'").run(); primaryRaw.prepare("UPDATE queue_item SET delivery_target='' ").run(); primaryRaw.close(); const migrated = createService(primaryPath); expect(migrated.getScope(primaryResult.scopeID).items[0].deliveryTarget).toEqual({ kind: 'primary' }); migrated.close();
  });

  it('converts v4 Assistant parts and attachments into ordered deliveryParts', () => {
    const pathname = dbPath(); const service = createService(pathname); const result = service.admit(admission()); service.close();
    const legacyTarget = { kind: 'assistant', assistantID: 'assistant-1', providerID: 'provider', modelID: 'model', parts: [{ type: 'text', text: 'first' }, { type: 'file', mime: 'image/png', url: 'https://files.example/part.png' }, { type: 'text', text: 'last' }], attachments: [{ mime: 'text/plain', url: 'https://files.example/attachment.txt' }] };
    const raw = new Database(pathname); raw.prepare("UPDATE queue_meta SET value='4' WHERE key='schema_version'").run(); raw.prepare('UPDATE queue_item SET delivery_target=? WHERE queue_item_id=?').run(JSON.stringify(legacyTarget), 'item-1'); raw.close();
    const migrated = createService(pathname); const item = migrated.getScope(result.scopeID).items[0];
    expect(item).toMatchObject({ deliveryTarget: { kind: 'assistant', assistantID: 'assistant-1' }, deliveryParts: [{ type: 'text', text: 'first' }, { type: 'file', mime: 'image/png', url: 'https://files.example/part.png' }, { type: 'text', text: 'last' }, { type: 'file', mime: 'text/plain', url: 'https://files.example/attachment.txt' }] });
    migrated.close();
    const check = new Database(pathname); const target = JSON.parse(check.prepare('SELECT delivery_target FROM queue_item WHERE queue_item_id=?').get('item-1').delivery_target); check.close();
    expect(target).toMatchObject({ deliveryParts: item.deliveryParts }); expect(target).not.toHaveProperty('parts'); expect(target).not.toHaveProperty('attachments');
  });

  it('migrates a hand-authored v1 fixture with lifecycle states, receipts, and worktree orders', () => {
    const pathname = dbPath();
    const raw = createV1Fixture(pathname);
    raw.prepare("INSERT INTO queue_scope VALUES ('scope-1','legacy-runtime','/repo','session-1',7,'active',1,1)").run();
    const item = raw.prepare('INSERT INTO queue_item VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const attempt = raw.prepare('INSERT INTO queue_attempt(queue_item_id,message_id,attempt_count,lease_expires_at,reconciliation_state) VALUES (?,?,?,?,?)');
    for (const [index, status] of ['queued', 'sending', 'reconciling', 'failed'].entries()) {
      item.run(`item-${index}`, `operation-${index}`, 'scope-1', status, null, null, index, status, 1, 1, 1);
      attempt.run(`item-${index}`, `message-${index}`, index, status === 'sending' ? 1 : null, status === 'reconciling' ? 'reconciling' : null);
    }
    raw.prepare("INSERT INTO operation_receipt VALUES ('legacy-runtime','legacy-request','queue','hash','{}',7,?)").run(Date.now());
    raw.prepare("INSERT INTO worktree_order VALUES ('legacy-runtime','/project','[\"/repo\"]',7,1)").run();
    raw.close();
    const reopened = createService(pathname);
    reopened.close();
    const check = new Database(pathname);
    expect(check.prepare("SELECT value FROM queue_meta WHERE key='schema_version'").get().value).toBe('5');
    expect(check.prepare("SELECT status FROM queue_item ORDER BY position").all().map((row) => row.status)).toEqual(['queued', 'reconciling', 'reconciling', 'failed']);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('queue_runtime','queue_attempt_history','queue_completion','queue_attachment')").all()).toHaveLength(4);
    expect(check.prepare("SELECT request_id FROM operation_receipt WHERE request_id='legacy-request'").get()).toBeTruthy();
    expect(check.prepare("SELECT ordered_paths FROM worktree_order WHERE project_directory='/project'").get().ordered_paths).toBe('["/repo"]');
    check.close();
  });

  it('rolls back every v1 migration change when a conflicting legacy table aborts the transaction', () => {
    const pathname = dbPath();
    const raw = createV1Fixture(pathname);
    raw.exec('CREATE TABLE queue_attempt_history (attempt_id TEXT PRIMARY KEY, queue_item_id TEXT NOT NULL)');
    raw.prepare("INSERT INTO queue_scope VALUES ('scope-rollback','legacy-runtime','/repo','session',0,'active',1,1)").run();
    raw.prepare("INSERT INTO queue_item VALUES ('item-rollback','operation-rollback','scope-rollback','preserved',NULL,NULL,0,'queued',1,1,1)").run();
    raw.prepare("INSERT INTO queue_attempt(queue_item_id,message_id,attempt_count) VALUES ('item-rollback','message-rollback',0)").run();
    raw.close();
    expect(() => createService(pathname)).toThrow(expect.objectContaining({ code: 'message_queue_invalid_schema' }));
    const check = new Database(pathname);
    expect(check.pragma('user_version', { simple: true })).toBe(1);
    expect(check.prepare("SELECT value FROM queue_meta WHERE key='schema_version'").get().value).toBe('1');
    expect(check.prepare('SELECT content FROM queue_item WHERE queue_item_id=?').get('item-rollback').content).toBe('preserved');
    expect(check.prepare("SELECT name FROM pragma_table_info('queue_item') WHERE name='due_at'").get()).toBeUndefined();
    check.close();
  });

  it('repairs partial v2 columns and indexes while rejecting irreparable partial v2 structures', () => {
    const repairPath = dbPath();
    const repair = createV1Fixture(repairPath, '2');
    repair.close();
    const repaired = createService(repairPath);
    repaired.close();
    const check = new Database(repairPath);
    expect(check.prepare("SELECT name FROM pragma_table_info('queue_item') WHERE name IN ('due_at','reconciliation_due_at','dispatch_generation','attachment_issues')").all()).toHaveLength(4);
    expect(check.prepare("SELECT name FROM pragma_table_info('queue_attempt') WHERE name IN ('edit_reservation_token','edit_reservation_owner','edit_reservation_expires_at','edit_reservation_generation')").all()).toHaveLength(4);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('queue_item_claim_due','queue_item_reconcile_due','queue_attempt_history_item')").all()).toHaveLength(3);
    check.close();

    const invalidPath = dbPath();
    const invalid = createV1Fixture(invalidPath, '2');
    invalid.exec('CREATE TABLE queue_attempt_history (attempt_id TEXT PRIMARY KEY, queue_item_id TEXT NOT NULL)');
    invalid.close();
    expect(() => createService(invalidPath)).toThrow(expect.objectContaining({ code: 'message_queue_invalid_schema' }));
  });

  it('repairs a legacy v3 import table without cascading its staging, sealed, or committed items', () => {
    const pathname = dbPath(); const service = createService(pathname);
    const stage = (requestID, kind, suffix, expectedGeneration) => {
      const created = service.createImport({ requestID: `${requestID}-create`, kind, clientID: requestID, snapshotHash: suffix.repeat(64), itemCount: 1, protocol: 4, expectedGeneration });
      const payload = { scope: { directory: '/repo', sessionID: `${requestID}-session` }, item: admission('unused', requestID).item };
      service.stageImport({ requestID: `${requestID}-stage`, importID: created.importID, scopeOrdinal: 0, itemOrdinal: 0, payload });
      return created;
    };
    const staging = stage('staging', 'activation', 'a', 0);
    const committed = stage('committed', 'activation', 'c', 0); const committedSeal = service.sealImport({ requestID: 'committed-seal', importID: committed.importID }); const committedResult = service.activateImport({ requestID: 'committed-commit', importID: committed.importID, expectedGeneration: 0, manifestHash: committedSeal.manifestHash, protocol: 4 });
    const sealed = stage('sealed', 'late', 'b', 1); const sealedResult = service.sealImport({ requestID: 'sealed-seal', importID: sealed.importID });
    service.close();
    const raw = new Database(pathname); raw.exec('DROP INDEX queue_import_active_snapshot_unique; ALTER TABLE queue_import DROP COLUMN commit_added;'); raw.close();
    const repaired = createService(pathname);
    expect(repaired.getImportDetails(staging.importID)).toMatchObject({ state: 'staging', staged: [{ scopeOrdinal: 0, itemOrdinal: 0 }] });
    expect(repaired.getImportDetails(sealed.importID)).toMatchObject({ state: 'sealed', manifestHash: sealedResult.manifestHash, staged: [{ scopeOrdinal: 0, itemOrdinal: 0 }] });
    expect(repaired.getImportDetails(committed.importID)).toMatchObject({ state: 'committed', commit: committedResult, staged: [{ scopeOrdinal: 0, itemOrdinal: 0 }] });
    expect(repaired.sealImport({ requestID: 'staging-seal', importID: staging.importID }).state).toBe('sealed');
    expect(repaired.commitLateImport({ requestID: 'sealed-commit', importID: sealed.importID, expectedGeneration: 1, manifestHash: sealedResult.manifestHash, protocol: 4 }).added).toBe(1);
    expect(repaired.activateImport({ requestID: 'committed-replay', importID: committed.importID, expectedGeneration: 0, manifestHash: committedSeal.manifestHash, protocol: 4 })).toEqual(committedResult);
    repaired.close();
  });

  it('adds the manual dispatch marker to old v3 databases and defaults it on new rows', () => {
    const pathname = dbPath(); const fresh = createService(pathname); fresh.close();
    let raw = new Database(pathname); expect(raw.prepare("SELECT dflt_value FROM pragma_table_info('queue_item') WHERE name='manual_dispatch_requested'").get().dflt_value).toBe('0'); raw.exec('ALTER TABLE queue_item DROP COLUMN manual_dispatch_requested'); raw.close();
    const repaired = createService(pathname); repaired.close(); raw = new Database(pathname);
    expect(raw.prepare("SELECT dflt_value FROM pragma_table_info('queue_item') WHERE name='manual_dispatch_requested'").get().dflt_value).toBe('0'); raw.close();
  });

  it('accepts canonical Composer sidecars and rejects unsupported payload shapes', () => {
    const service = createService(dbPath());
    expect(() => service.admit({ ...admission(), item: { ...admission().item, composerDocument: { text: 'different', references: [] } } })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.admit({ ...admission('request-2'), item: { ...admission().item, composerDocument: { text: 'hello', references: [], extra: true } } })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.admit({ ...admission('request-3'), item: { ...admission().item, sendConfig: { providerID: '' } } })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.admit({ ...admission('request-unknown'), ignored: true })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.admit({ ...admission('request-scope'), scope: { directory: '/repo', sessionID: 'session', ignored: true } })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.admit({ ...admission('request-model'), item: { ...admission().item, sendConfig: { providerID: 'openai' } } })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const accepted = service.admit({ ...admission('request-4'), item: { ...admission().item, queueItemID: 'item-4', operationID: 'operation-4', messageID: 'message-4', composerDocument: undefined, sendConfig: undefined } });
    expect(accepted).toMatchObject({ scopeID: expect.any(String), queueItemID: 'item-4', rowVersion: 1 });
    const pastedText = 'https://wxalangfuse.woa.com/project/cmoinpi2a00036t7pvewdai2s/users/135825155\n{"input":{"toolName":"controlAC"}}';
    const display = '[Pasted text 1]';
    const pasted = service.admit({
      ...admission('request-paste', 'paste'),
      item: {
        ...admission().item,
        queueItemID: 'item-paste',
        operationID: 'operation-paste',
        messageID: 'message-paste',
        content: pastedText,
        composerDocument: {
          text: display,
          references: [{ id: 'paste-1', kind: 'paste', display, start: 0, end: display.length, text: pastedText, characterCount: Array.from(pastedText).length, index: 1 }],
        },
      },
    });
    expect(service.getScope(pasted.scopeID).items.find((item) => item.queueItemID === pasted.queueItemID)).toMatchObject({ content: pastedText, composerDocument: { text: display } });
    service.close();
  });

  it('canonicalizes durable Composer skill and command references with strict sidecar and mention validation', () => {
    const service = createService(dbPath());
    const text = '/review /run @README';
    const input = admission('durable-composer', 'durable-composer');
    input.item.content = '[skill:review] [command:tasks/run.md] @README';
    input.item.composerDocument = {
      text,
      references: [
        { id: 'skill', kind: 'skill', skillName: 'review', display: '/review', start: 0, end: 7 },
        { id: 'command', kind: 'command', commandName: 'run', reference: 'tasks/run.md', display: '/run', start: 8, end: 12 },
      ],
    };
    input.item.composerMentions = [{ kind: 'file', value: 'README', path: '/repo/README', label: 'README', range: { start: 13, end: 20 } }];
    const admitted = service.admit(input);
    expect(admitted).toMatchObject({ queueItemID: 'item-durable-composer' });
    expect(service.getScope(admitted.scopeID).items[0]).toMatchObject({
      composerDocument: { text, references: input.item.composerDocument.references },
      composerMentions: input.item.composerMentions,
    });
    expect(service.getScope(admitted.scopeID).items[0].composerDocument).not.toHaveProperty('composerMentions');

    const malformed = structuredClone(input);
    malformed.requestID = 'durable-composer-malformed'; malformed.item.queueItemID = 'item-durable-composer-malformed'; malformed.item.operationID = 'operation-durable-composer-malformed'; malformed.item.messageID = 'message-durable-composer-malformed';
    malformed.item.composerDocument.references[1].reference = 'tasks]\nrun';
    expect(() => service.admit(malformed)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('enforces the complete UTF-8 admission JSON budget before canonical hashing and transaction work', () => {
    const service = createService(dbPath());
    service.setAssistantDeliveryService({ captureQueueDeliveryTarget: ({ assistantID }) => ({ kind: 'assistant', assistantID }) });
    const input = admission('admission-budget', 'admission-budget');
    input.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' };
    input.item.migrationImport = true;
    input.item.deliveryParts = [{ type: 'file', mime: 'application/octet-stream', url: '' }];
    const remaining = MESSAGE_QUEUE_ADMISSION_MAX_BYTES - Buffer.byteLength(JSON.stringify(input), 'utf8');
    input.item.deliveryParts[0].url = 'a'.repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBe(MESSAGE_QUEUE_ADMISSION_MAX_BYTES);
    expect(service.admit(input)).toMatchObject({ queueItemID: 'item-admission-budget' });

    const oversized = structuredClone(input);
    oversized.requestID = 'admission-budget-over'; oversized.item.queueItemID = 'item-admission-budget-over'; oversized.item.operationID = 'operation-admission-budget-over'; oversized.item.messageID = 'message-admission-budget-over';
    oversized.item.deliveryParts[0].url += '😀';
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(MESSAGE_QUEUE_ADMISSION_MAX_BYTES);
    expect(() => service.admit(oversized)).toThrow(expect.objectContaining({ code: 'admission_payload_limit' }));
    service.close();
  });

  it('rejects 71 MiB and 72 MiB service payloads before runtime hashing or transaction admission', () => {
    const getRuntimeConfig = vi.fn(() => ({ apiBaseUrl: 'http://runtime' }));
    const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig });
    const createHash = vi.spyOn(crypto, 'createHash');
    const oversized = (size, suffix) => {
      const input = admission(`service-limit-${suffix}`, `service-limit-${suffix}`);
      input.item.migrationImport = true;
      input.item.deliveryTarget = { kind: 'assistant', assistantID: 'assistant-1' };
      input.item.deliveryParts = [{ type: 'file', mime: 'application/octet-stream', url: '' }];
      input.item.deliveryParts[0].url = 'a'.repeat(size - Buffer.byteLength(JSON.stringify(input), 'utf8'));
      return input;
    };
    for (const [size, suffix] of [[71 * 1024 * 1024, '71'], [72 * 1024 * 1024, '72']]) {
      expect(() => service.admit(oversized(size, suffix))).toThrow(expect.objectContaining({ code: 'admission_payload_limit' }));
    }
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
    createHash.mockRestore();
    service.close();
  });

  it('stores receipt hashes only and keeps scope revision equal to the committed global revision', () => {
    const pathname = dbPath();
    const service = createService(pathname);
    const result = service.admit(admission());
    expect(service.getScope(result.scopeID).revision).toBe(result.revision);
    service.close();
    const raw = new Database(pathname);
    const receipt = raw.prepare('SELECT * FROM operation_receipt').get();
    expect(receipt.payload_hash).toHaveLength(64);
    expect(Object.keys(receipt)).not.toContain('payload');
    raw.close();
  });

  it('enforces idempotency, additive multi-scope admission, revisions, row versions, and complete reorder sets', () => {
    const service = createService(dbPath());
    const first = service.admit(admission());
    expect(() => service.admit(admission('request-1', '2'))).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    const second = service.admit({ ...admission('request-2', '2'), scope: { directory: '/repo', sessionID: 'session-2' } });
    expect(service.getScope(second.scopeID).sessionID).toBe('session-2');
    expect(() => service.admit({ ...admission('request-3', '3'), expectedRevision: 0 })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => service.edit({ requestID: 'edit-1', queueItemID: 'item-1', expectedRevision: first.revision, expectedRowVersion: 2, item: { content: 'updated', attachments: [], attachmentIssues: [] } })).toThrow(expect.objectContaining({ code: 'row_version_conflict' }));
    expect(() => service.reorder({ requestID: 'order-1', scopeID: first.scopeID, expectedRevision: first.revision, queueItemIDs: [] })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('replays a completed admission after dispatch replaces its message ID', () => {
    const service = createService(dbPath());
    const input = admission('admit-original', 'completed-replay');
    service.admit(input);
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const claim = service.claimNext({ owner: 'worker' });
    const attempt = service.beginAttempt({ queueItemID: input.item.queueItemID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, messageID: 'msg_dispatch_replay' });
    expect(() => service.completeAttempt({ queueItemID: input.item.queueItemID, operationID: 'operation-crossed', messageID: attempt.messageID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(() => service.completeAttempt({ queueItemID: input.item.queueItemID, operationID: input.item.operationID, messageID: 'msg_crossed', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(service.getScope(claim.item.scopeID).items).toHaveLength(1);
    service.completeAttempt({ queueItemID: input.item.queueItemID, operationID: input.item.operationID, messageID: attempt.messageID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration });

    expect(service.admit({ ...input, requestID: 'admit-replay' })).toMatchObject({
      queueItemID: input.item.queueItemID,
      operationID: input.item.operationID,
      messageID: attempt.messageID,
      completed: true,
      duplicate: true,
    });
    expect(() => service.admit({ ...input, requestID: 'admit-crossed', item: { ...input.item, operationID: 'operation-crossed' } })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    service.close();
  });

  it('fences only the reserved item while scope reorder remains client-mutable', () => {
    const service = createService(dbPath()); const admitted = service.admit(admission());
    const reservation = service.reserveForEdit({ requestID: 'reserve', queueItemID: 'item-1', expectedRevision: admitted.revision, rowVersion: admitted.rowVersion, owner: 'editor', ttlMs: 10_000 });
    expect(() => service.edit({ requestID: 'reserved-edit', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion, item: { content: 'updated' } })).toThrow(expect.objectContaining({ code: 'reserved' }));
    expect(() => service.remove({ requestID: 'reserved-remove-ordinary', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion })).toThrow(expect.objectContaining({ code: 'reserved' }));
    expect(() => service.manualSend({ requestID: 'reserved-send', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion })).toThrow(expect.objectContaining({ code: 'reserved' }));
    const reordered = service.reorder({ requestID: 'reserved-order', scopeID: admitted.scopeID, expectedRevision: admitted.revision, queueItemIDs: ['item-1'] });
    expect(reordered).toMatchObject({ scopeID: admitted.scopeID });
    expect(() => service.reservedRemove({ requestID: 'reserved-remove-stale', queueItemID: 'item-1', expectedRevision: reordered.revision, expectedRowVersion: admitted.rowVersion + 1, token: reservation.token, generation: reservation.generation + 1 })).toThrow(expect.objectContaining({ code: 'reserved' }));
    expect(service.reservedRemove({ requestID: 'reserved-remove', queueItemID: 'item-1', expectedRevision: reordered.revision, expectedRowVersion: admitted.rowVersion + 1, token: reservation.token, generation: reservation.generation })).toMatchObject({ removedQueueItemID: 'item-1' });
    expect(service.getScope(admitted.scopeID).items).toEqual([]); service.close();
  });

  it('lets a client discard or edit an active delivery tracking row', () => {
    const service = createService(dbPath());
    const first = service.admit(admission('active-remove', 'active-remove'));
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const firstClaim = service.claimNext({ owner: 'worker' });
    service.beginAttempt({ queueItemID: first.queueItemID, leaseToken: firstClaim.leaseToken, fenceGeneration: firstClaim.fenceGeneration, messageID: 'msg_active_remove' });
    const activeRemoveScope = service.getScope(first.scopeID);
    const activeRemoveItem = activeRemoveScope.items[0];
    expect(activeRemoveItem.status).toBe('sending');
    expect(service.remove({ requestID: 'discard-active', queueItemID: first.queueItemID, expectedRevision: activeRemoveScope.revision, expectedRowVersion: activeRemoveItem.rowVersion })).toMatchObject({ removedQueueItemID: first.queueItemID });
    expect(service.getScope(first.scopeID).items).toEqual([]);
    expect(service.confirmByMessage({ directory: '/repo', sessionID: 'session-1', messageID: 'msg_active_remove' })).toMatchObject({ completed: false });

    const secondInput = admission('active-edit', 'active-edit');
    const second = service.admit(secondInput);
    const secondClaim = service.claimNext({ owner: 'worker' });
    service.beginAttempt({ queueItemID: second.queueItemID, leaseToken: secondClaim.leaseToken, fenceGeneration: secondClaim.fenceGeneration, messageID: 'msg_active_edit' });
    const activeEditScope = service.getScope(second.scopeID);
    const activeEditItem = activeEditScope.items[0];
    const reservation = service.reserveForEdit({ requestID: 'reserve-active', queueItemID: second.queueItemID, expectedRevision: activeEditScope.revision, rowVersion: activeEditItem.rowVersion, owner: 'editor', ttlMs: 10_000 });
    expect(reservation).toMatchObject({ queueItemID: second.queueItemID, revision: activeEditScope.revision });
    expect(service.reservedRemove({ requestID: 'edit-active', queueItemID: second.queueItemID, expectedRevision: reservation.revision, expectedRowVersion: activeEditItem.rowVersion, token: reservation.token, generation: reservation.generation })).toMatchObject({ removedQueueItemID: second.queueItemID });
    expect(service.getScope(second.scopeID).items).toEqual([]);
    service.close();
  });

  it('normalizes sending records as one durable revision with matching scope revision', () => {
    const pathname = dbPath(); const service = createService(pathname); const admitted = service.admit(admission()); service.close();
    const raw = new Database(pathname); raw.prepare("UPDATE queue_item SET status = 'sending'").run(); raw.close();
    const reopened = createService(pathname); const snapshot = reopened.snapshot(); expect(snapshot.revision).toBe(admitted.revision + 1); expect(snapshot.scopes[0].revision).toBe(snapshot.revision); expect(reopened.getScope(admitted.scopeID).items[0].status).toBe('reconciling'); reopened.close();
    const check = new Database(pathname); expect(check.prepare('SELECT reconciliation_state FROM queue_attempt').get().reconciliation_state).toBe('reconciling'); check.close();
  });

  it('keeps revision stable across restart without sending records', () => {
    const pathname = dbPath(); const service = createService(pathname); const admitted = service.admit(admission()); service.close();
    const reopened = createService(pathname); expect(reopened.snapshot().revision).toBe(admitted.revision); reopened.close();
  });

  it('freezes worktree writes while preserving removable queue rows through rollback and commit', () => {
    const service = createService(dbPath()); const added = service.admit(admission());
    const order = service.setWorktreeOrder({ requestID: 'worktree-before-delete', projectDirectory: '/project', expectedRevision: 0, orderedPaths: ['/repo', '/other'] });
    const prepared = service.prepareWorktreeDeletion({ requestID: 'delete-1', directory: '/repo' });
    expect(prepared).toMatchObject({ token: expect.any(String), statusCounts: { queued: 1 } });
    expect(() => service.edit({ requestID: 'edit-locked', queueItemID: 'item-1', expectedRevision: prepared.revision, expectedRowVersion: 1, item: { content: 'updated', attachments: [], attachmentIssues: [] } })).toThrow(expect.objectContaining({ code: 'scope_locked' }));
    service.rollbackWorktreeDeletion({ requestID: 'delete-2', directory: '/repo', token: prepared.token });
    expect(service.getScope(added.scopeID).worktreeState).toBe('active');
    const next = service.prepareWorktreeDeletion({ requestID: 'delete-3', directory: '/repo' });
    const committed = service.commitWorktreeDeletion({ requestID: 'delete-4', directory: '/repo', projectDirectory: '/project', token: next.token });
    expect(service.getScope(added.scopeID).items).toHaveLength(1);
    expect(committed).toMatchObject({ state: 'deleted', scopeCount: 1 });
    expect(service.getWorktreeOrder('/project')).toMatchObject({ orderedPaths: ['/other'], revision: committed.revision });
    expect(service.getWorktreeOrder('/project').revision).toBeGreaterThan(order.revision);
    service.close();
  });

  it('publishes shared worktree orders in changes snapshots with revision CAS', async () => {
    const service = createService(dbPath()); const pending = service.waitForChange(0, { timeoutMs: 100 });
    const result = service.setWorktreeOrder({ requestID: 'worktree-1', projectDirectory: '/repo/', expectedRevision: 0, orderedPaths: ['/repo/a/'] });
    expect(result).toEqual({ revision: result.revision, projectDirectory: '/repo' });
    const changes = await pending;
    expect(changes.worktreeOrders).toEqual([{ projectDirectory: '/repo', orderedPaths: ['/repo/a'], revision: result.revision }]);
    expect(changes.scopes).toEqual([]);
    expect(() => service.setWorktreeOrder({ requestID: 'worktree-2', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: [] })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    service.close();
  });

  it('returns catalog-only changes with item counts and bounds worktree paths', async () => {
    const service = createService(dbPath());
    const admitted = service.admit(admission());
    const changes = await service.waitForChange(0, { timeoutMs: 0 });
    expect(changes.scopes[0]).toEqual({
      scopeID: admitted.scopeID,
      revision: admitted.revision,
      directory: '/repo',
      sessionID: 'session-1',
      worktreeState: 'active',
      itemCount: 1,
    });
    expect(changes.scopes[0]).not.toHaveProperty('items');
    expect(JSON.stringify(changes)).not.toContain('hello');
    expect(() => service.setWorktreeOrder({ requestID: 'too-many', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: Array.from({ length: 1025 }, (_, index) => `/repo/${index}`) })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('returns catalog-only snapshots and bounded scope pages', () => {
    const service = createService(dbPath());
    const first = service.admit(admission());
    for (let index = 2; index <= 10; index += 1) service.admit(admission(`page-${index}`, String(index)));
    const snapshot = service.snapshot();
    expect(snapshot.scopes[0]).toMatchObject({ scopeID: first.scopeID, itemCount: 10 });
    expect(JSON.stringify(snapshot)).not.toContain('hello');
    const page = service.getScope(first.scopeID);
    expect(page.items).toHaveLength(8);
    expect(page.nextOffset).toBe(8);
    expect(() => service.getScope(first.scopeID, { offset: 8, limit: 8 })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    const secondPage = service.getScope(first.scopeID, { offset: 8, limit: 8, expectedRevision: page.revision });
    expect(secondPage.itemCount).toBe(10);
    expect(secondPage).not.toHaveProperty('nextOffset');
    const queueItemIDs = [...page.items, ...secondPage.items].map((item) => item.queueItemID);
    service.reorder({ requestID: 'page-reorder', scopeID: first.scopeID, expectedRevision: page.revision, queueItemIDs: queueItemIDs.reverse() });
    expect(() => service.getScope(first.scopeID, { offset: 8, limit: 8, expectedRevision: page.revision })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => service.getScope(first.scopeID, { offset: 0, limit: 9 })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('isolates receipts and item mutations by runtime', () => {
    const pathname = dbPath();
    const runtimeA = createService(pathname, 'http://runtime-a');
    const admitted = runtimeA.admit(admission('shared-request'));
    const runtimeB = createService(pathname, 'http://runtime-b');
    const runtimeBOrder = runtimeB.setWorktreeOrder({ requestID: 'shared-request', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: ['/repo/b'] });
    expect(runtimeB.getWorktreeOrder('/repo').orderedPaths).toEqual(['/repo/b']);
    expect(() => runtimeB.edit({ requestID: 'runtime-b-edit', queueItemID: admitted.queueItemID, expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion, item: { content: 'cross-runtime' } })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => runtimeB.remove({ requestID: 'runtime-b-remove', queueItemID: admitted.queueItemID, expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(runtimeA.getScope(admitted.scopeID).items[0].content).toBe('hello');
    runtimeB.close();
    runtimeA.close();
  });

  it('keeps lifecycle operation kinds distinct and resumes deletion with one token', () => {
    const service = createService(dbPath());
    service.markWorktreeActive({ requestID: 'lifecycle-request', directory: '/repo' });
    expect(() => service.prepareWorktreeDeletion({ requestID: 'lifecycle-request', directory: '/repo' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    const first = service.prepareWorktreeDeletion({ requestID: 'prepare-1', directory: '/repo' });
    const resumed = service.prepareWorktreeDeletion({ requestID: 'prepare-2', directory: '/repo' });
    expect(resumed.token).toBe(first.token);
    expect(resumed.revision).toBeGreaterThan(first.revision);
    service.close();
  });

  it('bounds every receipt type by age and count with compact response JSON', () => {
    const pathname = dbPath();
    let currentTime = 1_000;
    const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => currentTime });
    service.admit(admission('queue-receipt'));
    const first = service.setWorktreeOrder({ requestID: 'old-order-receipt', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: ['/repo/a'] });
    currentTime += 31 * 24 * 60 * 60 * 1000;
    service.setWorktreeOrder({ requestID: 'new-order-receipt', projectDirectory: '/repo', expectedRevision: first.revision, orderedPaths: ['/repo/b'] });
    service.close();
    const raw = new Database(pathname);
    expect(raw.prepare('SELECT request_id FROM operation_receipt ORDER BY request_id').all()).toEqual([{ request_id: 'new-order-receipt' }]);
    expect(raw.prepare('SELECT response_json FROM operation_receipt').get().response_json).not.toContain('orderedPaths');
    expect(raw.prepare('SELECT response_json FROM operation_receipt').get().response_json).not.toContain('hello');
    raw.close();
  });

  it('enforces receipt expiry on reads and preserves replay inside the idempotency window', () => {
    const pathname = dbPath();
    let currentTime = 1_000;
    const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => currentTime });
    const input = { requestID: 'receipt-window', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: ['/repo/a'] };
    const first = service.setWorktreeOrder(input);
    expect(service.setWorktreeOrder(input)).toEqual(first);
    currentTime += 31 * 24 * 60 * 60 * 1000;
    expect(() => service.setWorktreeOrder(input)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    service.close();
  });

  it('cleans expired receipts at startup without advancing the global revision', () => {
    const pathname = dbPath();
    let currentTime = 1_000;
    const first = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => currentTime });
    const result = first.setWorktreeOrder({ requestID: 'startup-expired', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: [] });
    first.close();
    currentTime += 31 * 24 * 60 * 60 * 1000;
    const reopened = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => currentTime });
    expect(reopened.snapshot().revision).toBe(result.revision);
    reopened.close();
    const raw = new Database(pathname);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get().count).toBe(0);
    raw.close();
  });

  it('preserves a deleting lifecycle token when marking a worktree active', () => {
    const service = createService(dbPath());
    const prepared = service.prepareWorktreeDeletion({ requestID: 'prepare', directory: '/repo' });
    expect(() => service.markWorktreeActive({ requestID: 'repair', directory: '/repo' })).toThrow(expect.objectContaining({ code: 'scope_locked' }));
    const resumed = service.prepareWorktreeDeletion({ requestID: 'resume', directory: '/repo' });
    expect(resumed.token).toBe(prepared.token);
    service.close();
  });

  it('reads lifecycle recovery state and rolls back with its deletion token', () => {
    const service = createService(dbPath());
    expect(service.getWorktreeLifecycle('/repo/')).toEqual({ state: 'active', token: null });
    const prepared = service.prepareWorktreeDeletion({ requestID: 'prepare-recovery', directory: '/repo' });
    expect(service.getWorktreeLifecycle('/repo')).toEqual({ state: 'deleting', token: prepared.token });
    expect(() => service.rollbackWorktreeDeletion({ requestID: 'rollback-wrong', directory: '/repo', token: 'wrong-token' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    service.rollbackWorktreeDeletion({ requestID: 'rollback-recovery', directory: '/repo', token: prepared.token });
    expect(service.getWorktreeLifecycle('/repo')).toEqual({ state: 'active', token: null });
    expect(() => service.getWorktreeLifecycle('')).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('keeps captured lifecycle runtime keys isolated across runtime config changes', () => {
    const pathname = dbPath();
    let apiBaseUrl = 'http://runtime-a';
    const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl }) });
    const runtimeA = service.getRuntimeKey();
    apiBaseUrl = 'http://runtime-b';
    const runtimeB = service.getRuntimeKey();
    const options = { runtimeKey: runtimeA };
    const prepared = service.prepareWorktreeDeletion({ requestID: 'prepare-a', directory: '/repo' }, options);
    expect(service.getWorktreeLifecycle('/repo', options)).toEqual({ state: 'deleting', token: prepared.token });
    expect(service.getWorktreeLifecycle('/repo', { runtimeKey: runtimeB })).toEqual({ state: 'active', token: null });
    service.rollbackWorktreeDeletion({ requestID: 'rollback-a', directory: '/repo', token: prepared.token }, options);
    service.markWorktreeActive({ requestID: 'mark-a', directory: '/repo' }, options);
    expect(service.getWorktreeLifecycle('/repo', options)).toEqual({ state: 'active', token: null });
    const raw = new Database(pathname);
    expect(raw.prepare('SELECT runtime_key FROM worktree_lifecycle ORDER BY runtime_key').all()).toEqual([{ runtime_key: runtimeA }]);
    raw.close();
    expect(() => service.getWorktreeLifecycle('/repo', { runtimeKey: 'invalid' })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => service.prepareWorktreeDeletion({ requestID: 'invalid-runtime', directory: '/repo' }, { runtimeKey: 'invalid' })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('keeps at most 16,384 receipts for one runtime', () => {
    const pathname = dbPath();
    const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => 31 * 24 * 60 * 60 * 1000 });
    const first = service.setWorktreeOrder({ requestID: 'seed', projectDirectory: '/repo', expectedRevision: 0, orderedPaths: [] });
    const raw = new Database(pathname);
    const insert = raw.prepare('INSERT INTO operation_receipt(runtime_key,request_id,operation_type,payload_hash,response_json,committed_revision,created_at) VALUES (?,?,?,?,?,?,?)');
    const key = service.getRuntimeKey();
    for (let index = 0; index < 16_384; index += 1) insert.run(key, `old-${index}`, 'queue', String(index), '{"revision":1}', 1, 31 * 24 * 60 * 60 * 1000);
    raw.close();
    service.setWorktreeOrder({ requestID: 'trim', projectDirectory: '/repo', expectedRevision: first.revision, orderedPaths: ['/repo/a'] });
    const check = new Database(pathname);
    expect(check.prepare('SELECT COUNT(*) AS count FROM operation_receipt WHERE runtime_key = ?').get(key).count).toBe(16_384);
    expect(check.prepare("SELECT 1 FROM operation_receipt WHERE request_id = 'trim'").get()).toBeTruthy();
    check.close();
    service.close();
  });

  it('normalizes URL runtime keys like the shared runtime switcher', () => {
    const pathname = dbPath();
    const slash = createService(pathname, 'http://runtime.example/');
    const query = createService(pathname, 'http://runtime.example/?source=test#fragment');
    const defaultPort = createService(pathname, 'http://runtime.example:80');
    expect(query.getRuntimeKey()).toBe(slash.getRuntimeKey());
    expect(defaultPort.getRuntimeKey()).toBe(slash.getRuntimeKey());
    defaultPort.close();
    query.close();
    slash.close();
  });

  it('protects a newer schema without modifying its tables', () => {
    const pathname = dbPath(); const raw = new Database(pathname);
    raw.exec("CREATE TABLE queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO queue_meta VALUES ('schema_version', '99'); CREATE TABLE preserved (value TEXT);"); raw.close();
    expect(() => createService(pathname)).toThrow(expect.objectContaining({ code: 'message_queue_unsupported_schema' }));
    const check = new Database(pathname); expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preserved'").get()).toBeTruthy(); check.close();
  });

  it('fences active worker claims, records attempts, retries, and completion tombstones', () => {
    let time = 1_000;
    const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    service.admit({ ...admission(), item: { ...admission().item, dueAt: time } });
    expect(service.claimNext({ owner: 'worker' })).toBeNull();
    const authority = service.setQueueAuthority({ authority: 'active', expectedGeneration: 0 });
    const claim = service.claimNext({ owner: 'worker', leaseMs: 1_000 });
    expect(claim.fenceGeneration).toBe(authority.generation);
    const attempt = service.beginAttempt({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, messageID: 'msg_0000000001' });
    expect(attempt.messageID).not.toBe('message-1');
    service.scheduleRetry({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, dueAt: time + 1, errorCode: 'temporary' });
    time += 1;
    const retry = service.claimNext({ owner: 'worker' });
    const fresh = service.beginAttempt({ queueItemID: 'item-1', leaseToken: retry.leaseToken, fenceGeneration: retry.fenceGeneration, messageID: 'msg_0000000002' });
    const done = service.completeAttempt({ queueItemID: 'item-1', operationID: 'operation-1', messageID: fresh.messageID, leaseToken: retry.leaseToken, fenceGeneration: retry.fenceGeneration });
    expect(done.completed).toBe(true);
    expect(service.completeAttempt({ queueItemID: 'item-1', operationID: 'operation-1', messageID: fresh.messageID }).duplicate).toBe(true);
    service.close();
  });

  it('serializes eligibility probes across workers and fences expired probe tokens', () => {
    const pathname = dbPath(); let time = 1_000;
    const first = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const second = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    first.admit(admission()); first.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const reserved = first.reserveEligibilityCandidate({ owner: 'worker-a', leaseMs: 100 });
    expect(second.reserveEligibilityCandidate({ owner: 'worker-b', leaseMs: 100 })).toBeNull();
    expect(second.claimNext({ owner: 'worker-b', queueItemID: reserved.item.queueItemID, eligibilityToken: 'wrong' })).toBeNull();
    first.deferEligibilityCandidate({ queueItemID: reserved.item.queueItemID, eligibilityToken: reserved.eligibilityToken, fenceGeneration: reserved.fenceGeneration, delayMs: 10 });
    time += 11;
    const takeover = second.reserveEligibilityCandidate({ owner: 'worker-b', leaseMs: 100 });
    expect(first.claimNext({ owner: 'worker-a', queueItemID: reserved.item.queueItemID, eligibilityToken: reserved.eligibilityToken })).toBeNull();
    expect(second.claimNext({ owner: 'worker-b', queueItemID: takeover.item.queueItemID, eligibilityToken: takeover.eligibilityToken })).toMatchObject({ item: { status: 'sending' }, leaseToken: takeover.eligibilityToken });
    first.close(); second.close();
  });

  it('fences probe leases across authority changes and lets manual promotion preempt a probe', () => {
    const service = createService(dbPath());
    const head = service.admit(admission('head-request', 'head'));
    service.admit(admission('tail-request', 'tail'));
    const active = service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const oldProbe = service.reserveEligibilityCandidate({ owner: 'worker-a' });
    const paused = service.pauseAuthority({ expectedGeneration: active.generation });
    service.resumeAuthority({ expectedGeneration: paused.generation });
    const resumedProbe = service.reserveEligibilityCandidate({ owner: 'worker-b' });
    expect(resumedProbe.item.queueItemID).toBe(oldProbe.item.queueItemID);
    expect(service.claimNext({ owner: 'worker-a', queueItemID: oldProbe.item.queueItemID, eligibilityToken: oldProbe.eligibilityToken })).toBeNull();

    const scope = service.getScope(head.scopeID); const tail = scope.items.find((entry) => entry.queueItemID === 'item-tail');
    service.manualSend({ requestID: 'manual-tail', queueItemID: tail.queueItemID, expectedRevision: scope.revision, expectedRowVersion: tail.rowVersion });
    expect(service.claimNext({ owner: 'worker-b', queueItemID: resumedProbe.item.queueItemID, eligibilityToken: resumedProbe.eligibilityToken })).toBeNull();
    const manualProbe = service.reserveEligibilityCandidate({ owner: 'worker-c' });
    expect(manualProbe).toMatchObject({ item: { queueItemID: 'item-tail' }, dispatchMode: 'manual' });
    service.close();
  });

  it('lets client manual-send and reorder overwrite the waiting segment while an attempt is active', () => {
    const service = createService(dbPath());
    const head = service.admit(admission('head-request', 'head'));
    service.admit(admission('middle-request', 'middle'));
    service.admit(admission('tail-request', 'tail'));
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const probe = service.reserveEligibilityCandidate({ owner: 'worker' });
    const active = service.claimNext({ owner: 'worker', queueItemID: probe.item.queueItemID, eligibilityToken: probe.eligibilityToken });
    service.beginAttempt({ queueItemID: active.item.queueItemID, leaseToken: active.leaseToken, fenceGeneration: active.fenceGeneration, messageID: 'msg_0000000001' });

    let scope = service.getScope(head.scopeID); const tail = scope.items.find((entry) => entry.queueItemID === 'item-tail');
    service.manualSend({ requestID: 'client-promote-tail', queueItemID: tail.queueItemID, expectedRevision: scope.revision, expectedRowVersion: tail.rowVersion });
    scope = service.getScope(head.scopeID);
    expect(scope.items.map((entry) => entry.queueItemID)).toEqual(['item-head', 'item-tail', 'item-middle']);
    expect(scope.items[1]).toMatchObject({ manualDispatchRequested: true, status: 'queued' });

    service.reorder({ requestID: 'client-reorder-waiting', scopeID: scope.scopeID, expectedRevision: scope.revision, queueItemIDs: ['item-middle', 'item-tail', 'item-head'] });
    scope = service.getScope(head.scopeID);
    expect(scope.items.map((entry) => entry.queueItemID)).toEqual(['item-head', 'item-middle', 'item-tail']);
    expect(scope.items[0].status).toBe('sending');
    service.close();
  });

  it('allows a second manual dispatch after the first accepted row is reconciling, while sending still blocks concurrent POST', () => {
    let time = 1_000;
    const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    service.admit({ ...admission('first-request', 'first'), item: { ...admission('first-request', 'first').item, dueAt: time } });
    service.admit({ ...admission('second-request', 'second'), item: { ...admission('second-request', 'second').item, dueAt: time } });
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });

    const firstProbe = service.reserveEligibilityCandidate({ owner: 'worker-a' });
    expect(firstProbe.item.queueItemID).toBe('item-first');
    const firstClaim = service.claimNext({ owner: 'worker-a', queueItemID: firstProbe.item.queueItemID, eligibilityToken: firstProbe.eligibilityToken });
    service.beginAttempt({ queueItemID: firstClaim.item.queueItemID, leaseToken: firstClaim.leaseToken, fenceGeneration: firstClaim.fenceGeneration, messageID: 'msg_first_attempt' });
    // Concurrent POST is still blocked while status=sending.
    expect(service.reserveEligibilityCandidate({ owner: 'worker-b' })).toBeNull();

    service.markAcceptedForReconciliation({ queueItemID: firstClaim.item.queueItemID, leaseToken: firstClaim.leaseToken, fenceGeneration: firstClaim.fenceGeneration, dueAt: time });
    expect(service.getScope(firstClaim.item.scopeID).items.find((entry) => entry.queueItemID === 'item-first').status).toBe('reconciling');

    // reconciling only tracks confirmation; next manual intent may enter one sending/POST.
    let scope = service.getScope(firstClaim.item.scopeID);
    const second = scope.items.find((entry) => entry.queueItemID === 'item-second');
    const promoted = service.manualSend({ requestID: 'manual-second', queueItemID: second.queueItemID, expectedRevision: scope.revision, expectedRowVersion: second.rowVersion });
    // Dual-client replay of the same requestID keeps one commit.
    expect(service.manualSend({ requestID: 'manual-second', queueItemID: second.queueItemID, expectedRevision: scope.revision, expectedRowVersion: second.rowVersion })).toEqual(promoted);

    const secondProbe = service.reserveEligibilityCandidate({ owner: 'worker-c' });
    expect(secondProbe).toMatchObject({ item: { queueItemID: 'item-second' }, dispatchMode: 'manual' });
    const secondClaim = service.claimNext({ owner: 'worker-c', queueItemID: secondProbe.item.queueItemID, eligibilityToken: secondProbe.eligibilityToken });
    expect(secondClaim.item.status).toBe('sending');
    // Second concurrent POST remains blocked while the new row is sending.
    expect(service.reserveEligibilityCandidate({ owner: 'worker-d' })).toBeNull();
    service.close();
  });

  it('keeps markAmbiguous compatible with markAcceptedForReconciliation durable transition', () => {
    let time = 1_000;
    const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    service.admit({ ...admission(), item: { ...admission().item, dueAt: time } });
    service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const claim = service.claimNext({ owner: 'worker' });
    service.beginAttempt({ queueItemID: claim.item.queueItemID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, messageID: 'msg_accepted' });
    expect(service.markAcceptedForReconciliation({ queueItemID: claim.item.queueItemID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, dueAt: time })).toMatchObject({ queueItemID: 'item-1', status: 'reconciling' });
    service.close();
  });

  it('persists one manual dispatch intent through release and consumes it at beginAttempt', () => {
    let time = 1_000; const pathname = dbPath(); const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const admitted = service.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(false); service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const promoted = service.manualSend({ requestID: 'manual-intent', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion });
    expect(service.manualSend({ requestID: 'manual-intent', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion })).toEqual(promoted); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(true);
    const first = service.claimNext({ owner: 'worker' }); expect(first.dispatchMode).toBe('manual'); service.scheduleRetry({ queueItemID: 'item-1', leaseToken: first.leaseToken, fenceGeneration: first.fenceGeneration, dueAt: time, errorCode: 'attachment_materialization_failed' }); expect(service.getScope(admitted.scopeID).items[0]).toMatchObject({ status: 'retrying', manualDispatchRequested: true });
    const second = service.claimNext({ owner: 'worker' }); expect(second.dispatchMode).toBe('manual'); service.beginAttempt({ queueItemID: 'item-1', leaseToken: second.leaseToken, fenceGeneration: second.fenceGeneration, messageID: 'msg_0000000001' }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(false); service.scheduleRetry({ queueItemID: 'item-1', leaseToken: second.leaseToken, fenceGeneration: second.fenceGeneration, dueAt: time, errorCode: 'retry' }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(false);
    expect(service.claimNext({ owner: 'worker' }).dispatchMode).toBe('automatic'); service.close();
  });

  it('keeps a paused manual promotion pending until its resumed attempt begins', () => {
    let time = 1_000; const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const admitted = service.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); const active = service.setAuthority({ authority: 'active', expectedGeneration: 0 }); const paused = service.pauseAuthority({ expectedGeneration: active.generation });
    const scope = service.getScope(admitted.scopeID); const item = scope.items[0]; service.manualSend({ requestID: 'paused-manual-intent', queueItemID: item.queueItemID, expectedRevision: scope.revision, expectedRowVersion: item.rowVersion }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(true);
    service.resumeAuthority({ expectedGeneration: paused.generation }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(true);
    const claim = service.claimNext({ owner: 'worker' }); expect(claim.dispatchMode).toBe('manual'); service.beginAttempt({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, messageID: 'msg_0000000001' }); expect(service.getScope(admitted.scopeID).items[0].manualDispatchRequested).toBe(false); service.close();
  });

  it('renews edit reservations without advancing queue revisions and fences worker wakes', async () => {
    let time = 10_000; const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const admitted = service.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); const authority = service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const reservation = service.reserveForEdit({ requestID: 'reserve-renew', queueItemID: 'item-1', expectedRevision: admitted.revision, rowVersion: admitted.rowVersion, owner: 'editor', ttlMs: 1_000 }); const revision = service.snapshot().revision;
    time += 500; const renewed = service.renewEditReservation({ queueItemID: 'item-1', token: reservation.token, generation: authority.generation, ttlMs: 2_000 });
    time += 500; const [again, wake] = await Promise.all([Promise.resolve().then(() => service.renewEditReservation({ queueItemID: 'item-1', token: reservation.token, generation: authority.generation, ttlMs: 3_000 })), Promise.resolve().then(() => service.claimNext({ owner: 'woken-worker' }))]);
    expect(renewed.expiresAt).toBe(12_500); expect(again.expiresAt).toBe(14_000); expect(wake).toBeNull(); expect(service.snapshot().revision).toBe(revision); service.close();
  });

  it('rejects expired, mismatched, removed, and superseded reservation renewals', () => {
    let time = 10_000; const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const admitted = service.admit(admission()); const authority = service.setAuthority({ authority: 'active', expectedGeneration: 0 }); const reservation = service.reserveForEdit({ requestID: 'reserve-expiry', queueItemID: 'item-1', expectedRevision: admitted.revision, rowVersion: admitted.rowVersion, owner: 'editor', ttlMs: 1_000 });
    expect(() => service.renewEditReservation({ queueItemID: 'item-1', token: 'wrong', generation: authority.generation, ttlMs: 1_000 })).toThrow(expect.objectContaining({ code: 'reservation_token_mismatch' }));
    time += 6_001; expect(() => service.renewEditReservation({ queueItemID: 'item-1', token: reservation.token, generation: authority.generation, ttlMs: 1_000 })).toThrow(expect.objectContaining({ code: 'reservation_expired' }));
    const fresh = service.reserveForEdit({ requestID: 'reserve-fresh', queueItemID: 'item-1', expectedRevision: admitted.revision, rowVersion: admitted.rowVersion, owner: 'editor', ttlMs: 1_000 }); const paused = service.setAuthority({ authority: 'paused', expectedGeneration: authority.generation }); service.setAuthority({ authority: 'active', expectedGeneration: paused.generation });
    expect(() => service.renewEditReservation({ queueItemID: 'item-1', token: fresh.token, generation: fresh.generation, ttlMs: 1_000 })).toThrow(expect.objectContaining({ code: 'reservation_generation_conflict' }));
    const removed = service.reservedRemove({ requestID: 'remove-reserved', queueItemID: 'item-1', expectedRevision: admitted.revision, expectedRowVersion: admitted.rowVersion, token: fresh.token, generation: fresh.generation });
    expect(removed.removedQueueItemID).toBe('item-1'); expect(() => service.renewEditReservation({ queueItemID: 'item-1', token: fresh.token, generation: fresh.generation, ttlMs: 1_000 })).toThrow(expect.objectContaining({ code: 'not_found' })); service.close();
  });

  it('treats the exact reservation expiry as available to a worker', () => {
    let time = 10_000; const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const admitted = service.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); const authority = service.setAuthority({ authority: 'active', expectedGeneration: 0 }); const reservation = service.reserveForEdit({ requestID: 'reserve-exact-expiry', queueItemID: 'item-1', expectedRevision: admitted.revision, rowVersion: admitted.rowVersion, owner: 'editor', ttlMs: 1_000 });
    time = reservation.expiresAt; expect(() => service.renewEditReservation({ queueItemID: 'item-1', token: reservation.token, generation: authority.generation, ttlMs: 1_000 })).toThrow(expect.objectContaining({ code: 'reservation_expired' })); expect(service.claimNext({ owner: 'worker' })?.item.queueItemID).toBe('item-1'); service.close();
  });

  it('fences a scope claim when a stale position promotes a tail behind an active lease', () => {
    let time = 1_000; const pathname = dbPath(); const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    service.admit({ ...admission('claim-head', 'head'), item: { ...admission('claim-head', 'head').item, dueAt: time } }); service.admit({ ...admission('claim-tail', 'tail'), item: { ...admission('claim-tail', 'tail').item, dueAt: time } }); service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const active = service.claimNext({ owner: 'worker', leaseMs: 1_000 }); const raw = new Database(pathname); raw.prepare("UPDATE queue_item SET position=CASE queue_item_id WHEN 'item-tail' THEN 0 ELSE 1 END").run(); raw.close();
    expect(active.item.queueItemID).toBe('item-head'); expect(service.claimNext({ owner: 'worker-2', leaseMs: 1_000 })).toBeNull(); service.close();
  });

  it('binds ready attachment metadata without exposing upload tokens', () => {
    const service = createService(dbPath());
    const upload = service.createAttachmentUpload();
    service.markAttachmentReady({ ...upload, objectHash: 'hash-1', storageKey: 'objects/hash-1', sizeBytes: 12 });
    const input = admission('attachment');
    input.item = { ...input.item, queueItemID: 'attachment-item', operationID: 'attachment-operation', messageID: 'attachment-message', migrationImport: true, attachments: [{ uploadID: upload.uploadID, name: 'a.txt', sizeBytes: 12 }], composerDocument: { text: 'hello', references: [{ uploadID: upload.uploadID }] } };
    const result = service.admit(input);
    const item = service.getScope(result.scopeID).items[0];
    expect(item.attachments).toEqual([{ attachmentID: upload.uploadID, occurrenceRefID: ['root', upload.uploadID], filename: 'a.txt', mimeType: 'application/octet-stream', size: 12, source: 'local', locator: { kind: 'upload', uploadID: upload.uploadID, storageKey: 'objects/hash-1' } }]);
    expect(JSON.stringify(item)).not.toContain(upload.uploadToken);
    service.close();
  });

  it('limits authoritative attachment bytes across ordinary admission, migration, and edits', () => {
    const service = createService(dbPath()); const mib = 1024 * 1024;
    const ready = (id, size) => { const upload = service.createAttachmentUpload(); service.markAttachmentReady({ ...upload, objectHash: `hash-${id}`, storageKey: `objects/${id}`, sizeBytes: size }); return upload; };
    const largeA = ready('a', 25 * mib), largeB = ready('b', 25 * mib), small = ready('small', 1);
    const attachment = (upload, id, size = upload === largeA ? 25 * mib : upload === largeB ? 25 * mib : 1) => ({ attachmentID: id, occurrenceRefID: ['root', id], filename: `${id}.bin`, mimeType: 'application/octet-stream', size, source: 'local', locator: { kind: 'upload', uploadID: upload.uploadID } });
    const accepted = service.admit({ ...admission('total-ok'), item: { ...admission('total-ok').item, attachments: [attachment(largeA, 'a'), attachment(largeB, 'b')] } });
    expect(service.getScope(accepted.scopeID).items[0].attachments.map((entry) => entry.size)).toEqual([25 * mib, 25 * mib]);
    expect(() => service.admit({ ...admission('total-migration', 'migration'), item: { ...admission('total-migration', 'migration').item, migrationImport: true, attachments: [largeA, largeB, small].map((upload, index) => ({ uploadID: upload.uploadID, name: `legacy-${index}` })), attachmentIssues: [] } })).toThrow(expect.objectContaining({ code: 'attachment_total_limit' }));
    const current = service.getScope(accepted.scopeID); const before = current.items[0]; expect(() => service.edit({ requestID: 'total-edit', queueItemID: before.queueItemID, expectedRevision: current.revision, expectedRowVersion: before.rowVersion, item: { attachments: [attachment(largeA, 'edit-a'), attachment(largeB, 'edit-b'), attachment(small, 'edit-small')], attachmentIssues: [] } })).toThrow(expect.objectContaining({ code: 'attachment_total_limit' }));
    expect(service.getScope(accepted.scopeID).items[0].attachments.map((entry) => entry.attachmentID)).toEqual(['a', 'b']);
    expect(() => service.admit({ ...admission('fake-size', 'fake'), item: { ...admission('fake-size', 'fake').item, attachments: [attachment(largeA, 'fake', 1)] } })).toThrow(expect.objectContaining({ code: 'attachment_unavailable' })); service.close();
  });

  it('keeps unavailable reconciliation checks at zero across restart and honors its absolute deadline', () => {
    const pathname = dbPath(); let time = 1_000;
    const first = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    first.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); first.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const claim = first.claimNext({ owner: 'worker', leaseMs: 1 }); first.beginAttempt({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, messageID: 'msg_0000000001' }); first.markAmbiguous({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration });
    time += 3; const reconcile = first.claimDueReconcile({ owner: 'worker', leaseMs: 1 }); first.recordReconcileUnavailable({ queueItemID: 'item-1', leaseToken: reconcile.leaseToken, fenceGeneration: reconcile.fenceGeneration }); first.close();
    const reopened = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    expect(reopened.getScope(reopened.snapshot().scopes[0].scopeID).items[0]).toMatchObject({ status: 'reconciling', attemptCount: 1 });
    time += 31_000; const expired = reopened.claimDueReconcile({ owner: 'worker', leaseMs: 1 }); reopened.recordReconcileUnavailable({ queueItemID: 'item-1', leaseToken: expired.leaseToken, fenceGeneration: expired.fenceGeneration });
    expect(reopened.getScope(reopened.snapshot().scopes[0].scopeID).items[0].status).toBe('unresolved'); reopened.close();
  });

  it('keeps failed rows client-mutable without blocking later rows', () => {
    let time = 1_000; const service = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const first = service.admit({ ...admission(), item: { ...admission().item, dueAt: time } }); service.admit({ ...admission('second', '2'), item: { ...admission('second', '2').item, dueAt: time } }); service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const claim = service.claimNext({ owner: 'worker' }); service.markFailed({ queueItemID: 'item-1', leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration });
    expect(service.claimNext({ owner: 'worker' }).item.queueItemID).toBe('item-2'); expect(service.getScope(first.scopeID).items[0].status).toBe('failed'); service.close();
  });

  it('recovers expired sending leases, fences superseded authorities, preserves attempt history, and advances past terminal rows', () => {
    let time = 1_000;
    const pathname = dbPath();
    const service = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    service.admit({ ...admission(), item: { ...admission().item, dueAt: time } });
    const authority = service.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const expired = service.claimNext({ owner: 'expired-worker', leaseMs: 10 });
    time += 11;
    service.close();

    const reopened = createMessageQueueService({ dbPath: pathname, getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    expect(reopened.getScope(reopened.snapshot().scopes[0].scopeID).items[0].status).toBe('reconciling');
    const recovered = reopened.claimDueReconcile({ owner: 'worker', leaseMs: 100 });
    const nextAuthority = reopened.setAuthority({ authority: 'active', expectedGeneration: authority.generation });
    expect(() => reopened.renewLease({ queueItemID: 'item-1', leaseToken: recovered.leaseToken, fenceGeneration: recovered.fenceGeneration })).toThrow(expect.objectContaining({ code: 'lease_lost' }));

    time += 101;
    const fresh = reopened.claimDueReconcile({ owner: 'worker', leaseMs: 100 });
    reopened.beginAttempt({ queueItemID: 'item-1', leaseToken: fresh.leaseToken, fenceGeneration: fresh.fenceGeneration, messageID: 'msg_0000000001' });
    reopened.scheduleRetry({ queueItemID: 'item-1', leaseToken: fresh.leaseToken, fenceGeneration: fresh.fenceGeneration, dueAt: time, errorCode: 'retry' });
    const retry = reopened.claimNext({ owner: 'worker', leaseMs: 100 });
    const second = reopened.beginAttempt({ queueItemID: 'item-1', leaseToken: retry.leaseToken, fenceGeneration: retry.fenceGeneration, messageID: 'msg_0000000002' });
    const completed = reopened.completeAttempt({ queueItemID: 'item-1', operationID: 'operation-1', messageID: second.messageID, leaseToken: retry.leaseToken, fenceGeneration: retry.fenceGeneration });
    expect(reopened.completeAttempt({ queueItemID: 'item-1', operationID: 'operation-1', messageID: second.messageID })).toMatchObject({ queueItemID: completed.queueItemID, operationID: completed.operationID, messageID: completed.messageID, completed: true, duplicate: true });
    expect(() => reopened.completeAttempt({ operationID: 'operation-1', messageID: 'msg_crossed_identity' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(nextAuthority.generation).toBeGreaterThan(authority.generation);
    reopened.close();

    const check = new Database(pathname);
    expect(check.prepare('SELECT attempt_number,outcome FROM queue_attempt_history ORDER BY attempt_number').all()).toEqual([{ attempt_number: 1, outcome: 'retrying' }, { attempt_number: 2, outcome: 'completed' }]);
    check.close();

    const blocked = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const failed = blocked.admit({ ...admission('failed', 'failed'), item: { ...admission('failed', 'failed').item, dueAt: time } });
    blocked.admit({ ...admission('failed-later', 'failed-later'), item: { ...admission('failed-later', 'failed-later').item, dueAt: time } });
    blocked.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const failedClaim = blocked.claimNext({ owner: 'worker' });
    blocked.markFailed({ queueItemID: failedClaim.item.queueItemID, leaseToken: failedClaim.leaseToken, fenceGeneration: failedClaim.fenceGeneration });
    expect(blocked.claimNext({ owner: 'worker' }).item.queueItemID).toBe('item-failed-later');
    expect(blocked.getScope(failed.scopeID).items[0].status).toBe('failed');
    blocked.close();

    const unresolved = createMessageQueueService({ dbPath: dbPath(), getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime' }), clock: () => time });
    const unresolvedHead = unresolved.admit({ ...admission('unresolved', 'unresolved'), item: { ...admission('unresolved', 'unresolved').item, dueAt: time } });
    unresolved.admit({ ...admission('unresolved-later', 'unresolved-later'), item: { ...admission('unresolved-later', 'unresolved-later').item, dueAt: time } });
    unresolved.setAuthority({ authority: 'active', expectedGeneration: 0 });
    const unresolvedClaim = unresolved.claimNext({ owner: 'worker' });
    unresolved.markUnresolved({ queueItemID: unresolvedClaim.item.queueItemID, leaseToken: unresolvedClaim.leaseToken, fenceGeneration: unresolvedClaim.fenceGeneration });
    expect(unresolved.claimNext({ owner: 'worker' }).item.queueItemID).toBe('item-unresolved-later');
    expect(unresolved.getScope(unresolvedHead.scopeID).items[0].status).toBe('unresolved');
    unresolved.close();
  });

  it('stages, seals, activates, and confirms an import manifest idempotently', () => {
    const service = createService(dbPath());
    const created = service.createImport({ requestID: 'import-create', kind: 'activation', clientID: 'client', snapshotHash: 'a'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 0 });
    const payload = { scope: { directory: '/repo', sessionID: 'import-session' }, item: admission('unused', 'imported').item };
    service.stageImport({ requestID: 'import-stage', importID: created.importID, scopeOrdinal: 0, itemOrdinal: 0, payload });
    const sealed = service.sealImport({ requestID: 'import-seal', importID: created.importID });
    const activated = service.activateImport({ requestID: 'import-activate', importID: created.importID, expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 });
    expect(activated).toMatchObject({ added: 1, generation: 1, activationEpoch: 1, manifestHash: sealed.manifestHash });
    expect(service.getAuthority()).toMatchObject({ authority: 'active', activationEpoch: 1, manifestHash: sealed.manifestHash, protocol: 4 });
    expect(service.activateImport({ requestID: 'import-activate', importID: created.importID, expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 })).toEqual(activated);
    service.close();
  });

  it('retains import attempts by kind and replays the persisted commit after authority generations advance', () => {
    const service = createService(dbPath()); const hash = 'c'.repeat(64); const payload = { scope: { directory: '/repo', sessionID: 'replay-session' }, item: admission('unused', 'replay').item };
    const activation = service.createImport({ requestID: 'replay-create', kind: 'activation', clientID: 'device', snapshotHash: hash, itemCount: 1, protocol: 4, expectedGeneration: 0 });
    service.stageImport({ requestID: 'replay-stage', importID: activation.importID, scopeOrdinal: 0, itemOrdinal: 0, payload }); const sealed = service.sealImport({ requestID: 'replay-seal', importID: activation.importID }); const committed = service.activateImport({ requestID: 'replay-commit', importID: activation.importID, expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 });
    const paused = service.pauseAuthority({ expectedGeneration: committed.generation }); service.resumeAuthority({ expectedGeneration: paused.generation });
    expect(service.activateImport({ requestID: 'replay-after-resume', importID: activation.importID, expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 })).toEqual(committed);
    expect(service.createImport({ requestID: 'late-same-snapshot', kind: 'late', clientID: 'device', snapshotHash: hash, itemCount: 0, protocol: 4, expectedGeneration: service.getAuthority().generation }).importID).not.toBe(activation.importID);
    const abandoned = service.createImport({ requestID: 'abandoned-create', kind: 'late', clientID: 'device', snapshotHash: 'd'.repeat(64), itemCount: 0, protocol: 4, expectedGeneration: service.getAuthority().generation }); service.abandonImport({ requestID: 'abandoned', importID: abandoned.importID });
    expect(service.createImport({ requestID: 'abandoned-retry', kind: 'late', clientID: 'device', snapshotHash: 'd'.repeat(64), itemCount: 0, protocol: 4, expectedGeneration: service.getAuthority().generation }).importID).not.toBe(abandoned.importID);
    expect(service.getImportDetails(activation.importID)).toMatchObject({ state: 'committed', itemCount: 1, commit: committed, staged: [{ scopeOrdinal: 0, itemOrdinal: 0 }] }); service.close();
  });

  it('keeps staging revisions private, fences resume to paused, and preserves active authority through late commit', () => {
    const service = createService(dbPath()); const payload = { scope: { directory: '/repo', sessionID: 'import-session' }, item: admission('unused', 'imported').item };
    const activation = service.createImport({ requestID: 'create-a', kind: 'activation', clientID: 'a', snapshotHash: 'a'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: 0 });
    const beforeStage = service.snapshot().revision; service.stageImport({ requestID: 'stage-a', importID: activation.importID, scopeOrdinal: 0, itemOrdinal: 0, payload }); expect(service.snapshot().revision).toBe(beforeStage);
    const sealed = service.sealImport({ requestID: 'seal-a', importID: activation.importID }); service.activateImport({ requestID: 'activate-a', importID: activation.importID, expectedGeneration: 0, manifestHash: sealed.manifestHash, protocol: 4 });
    const active = service.getAuthority(); const latePayload = { scope: { directory: '/repo', sessionID: 'import-session' }, item: admission('unused', 'late').item };
    const late = service.createImport({ requestID: 'create-l', kind: 'late', clientID: 'l', snapshotHash: 'b'.repeat(64), itemCount: 1, protocol: 4, expectedGeneration: active.generation }); service.stageImport({ requestID: 'stage-l', importID: late.importID, scopeOrdinal: 0, itemOrdinal: 0, payload: latePayload }); const lateSeal = service.sealImport({ requestID: 'seal-l', importID: late.importID }); service.commitLateImport({ requestID: 'commit-l', importID: late.importID, expectedGeneration: active.generation, manifestHash: lateSeal.manifestHash, protocol: 4 });
    expect(service.getAuthority()).toMatchObject(active); expect(() => service.resumeAuthority({ expectedGeneration: active.generation })).toThrow(expect.objectContaining({ code: 'generation_conflict' })); service.close();
  });

  it('counts only new late-import identities against the runtime item limit across sequential commits', () => {
    const pathname = dbPath(); const seeded = createService(pathname); const key = seeded.getRuntimeKey(); const seededItem = seeded.admit({ ...admission('seed-limit', 'seed-limit'), scope: { directory: '/repo', sessionID: 'limit-session' } }); seeded.close();
    const raw = new Database(pathname); raw.pragma('foreign_keys = ON'); raw.exec('BEGIN');
    raw.prepare("INSERT INTO queue_runtime(runtime_key,authority,generation,activation_epoch,protocol,updated_at) VALUES (?,'active',1,1,4,1)").run(key);
    const insertItem = raw.prepare("INSERT INTO queue_item(queue_item_id,operation_id,scope_id,content,position,status,row_version,created_at,updated_at,due_at,attachment_issues) VALUES (?,?,?,'hello',?,'queued',1,1,1,1,'[]')");
    const insertAttempt = raw.prepare('INSERT INTO queue_attempt(queue_item_id,message_id,attempt_count,reconciliation_checks,reconciliation_unavailable_checks) VALUES (?,?,0,0,0)');
    for (let index = 1; index < 2046; index++) { insertItem.run(`limit-item-${index}`, `limit-operation-${index}`, seededItem.scopeID, index); insertAttempt.run(`limit-item-${index}`, `limit-message-${index}`); }
    raw.prepare("INSERT INTO queue_completion(operation_id,message_id,queue_item_id,runtime_key,source,completed_at,completion_json) VALUES ('tomb-operation','tomb-message','tomb-item',?,'test',1,'{}')").run(key); raw.exec('COMMIT'); raw.close();
    const service = createService(pathname);
    const stage = (name, items) => {
      const created = service.createImport({ requestID: `${name}-create`, kind: 'late', clientID: name, snapshotHash: ({ 'late-first': 'a', 'late-second': 'b', 'late-overflow': 'c' })[name].repeat(64), itemCount: items.length, protocol: 4, expectedGeneration: 1 });
      items.forEach((item, index) => service.stageImport({ requestID: `${name}-stage-${index}`, importID: created.importID, scopeOrdinal: 0, itemOrdinal: index, payload: { scope: { directory: '/repo', sessionID: 'limit-session' }, item } }));
      const sealed = service.sealImport({ requestID: `${name}-seal`, importID: created.importID });
      return { created, sealed };
    };
    const exact = admission('unused', 'limit-item-1').item; exact.queueItemID = 'limit-item-1'; exact.operationID = 'limit-operation-1'; exact.messageID = 'limit-message-1';
    const tombstone = admission('unused', 'tomb').item; tombstone.queueItemID = 'tomb-item'; tombstone.operationID = 'tomb-operation'; tombstone.messageID = 'tomb-message';
    const addition = (suffix) => ({ ...admission('unused', suffix).item, queueItemID: `late-item-${suffix}`, operationID: `late-operation-${suffix}`, messageID: `late-message-${suffix}` });
    const first = stage('late-first', [exact, tombstone, addition('one')]); expect(service.commitLateImport({ requestID: 'late-first-commit', importID: first.created.importID, expectedGeneration: 1, manifestHash: first.sealed.manifestHash, protocol: 4 }).added).toBe(1);
    const second = stage('late-second', [addition('two')]); expect(service.commitLateImport({ requestID: 'late-second-commit', importID: second.created.importID, expectedGeneration: 1, manifestHash: second.sealed.manifestHash, protocol: 4 }).added).toBe(1);
    const overflow = stage('late-overflow', [addition('three')]); expect(() => service.commitLateImport({ requestID: 'late-overflow-commit', importID: overflow.created.importID, expectedGeneration: 1, manifestHash: overflow.sealed.manifestHash, protocol: 4 })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    service.close();
  });

  it('evicts oldest empty scopes when admission reaches the scope cap', () => {
    const service = createService(dbPath());
    const admissionFor = (suffix) => ({ requestID: `request-${suffix}`, scope: { directory: '/repo', sessionID: `session-${suffix}` }, item: { queueItemID: `item-${suffix}`, operationID: `operation-${suffix}`, messageID: `message-${suffix}`, content: 'hello', attachments: [], attachmentIssues: [], createdAt: 100 } });
    let retained; const emptied = [];
    for (let index = 0; index < 128; index += 1) {
      const result = service.admit(admissionFor(index));
      if (index === 0) { retained = result; continue; }
      service.remove({ requestID: `remove-${index}`, queueItemID: result.queueItemID, expectedRevision: result.revision, expectedRowVersion: 1 });
      emptied.push(result.scopeID);
    }
    expect(service.snapshot().scopes).toHaveLength(128);
    const fresh = service.admit(admissionFor('fresh'));
    expect(service.getScope(fresh.scopeID).items).toHaveLength(1);
    expect(service.snapshot().scopes).toHaveLength(128);
    const remaining = new Set(service.snapshot().scopes.map((scope) => scope.scopeID));
    expect(remaining.has(fresh.scopeID)).toBe(true);
    expect(remaining.has(retained.scopeID)).toBe(true);
    expect(emptied.filter((scopeID) => remaining.has(scopeID))).toHaveLength(emptied.length - 1);
    expect(service.getScope(retained.scopeID).items[0]).toMatchObject({ queueItemID: retained.queueItemID });
    service.close();
  });

  it('fails admission with scope_limit when every scope at the cap still holds items', () => {
    const service = createService(dbPath());
    const admissionFor = (suffix) => ({ requestID: `request-${suffix}`, scope: { directory: '/repo', sessionID: `session-${suffix}` }, item: { queueItemID: `item-${suffix}`, operationID: `operation-${suffix}`, messageID: `message-${suffix}`, content: 'hello', attachments: [], attachmentIssues: [], createdAt: 100 } });
    for (let index = 0; index < 128; index += 1) service.admit(admissionFor(index));
    expect(() => service.admit(admissionFor('overflow'))).toThrow(expect.objectContaining({ code: 'scope_limit' }));
    service.close();
  });
});
