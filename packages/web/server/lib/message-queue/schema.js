import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';

const MESSAGE_QUEUE_SCHEMA_VERSION = 5;

const schemaError = (code) => Object.assign(new Error(code), { code });
const tableNames = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
const uniqueColumns = (db, table) => db.prepare(`PRAGMA index_list(${table})`).all().filter((row) => row.unique).map((row) => db.prepare(`PRAGMA index_info(${row.name})`).all().map((entry) => entry.name).join(','));
const foreignKeys = (db, table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => `${row.from}:${row.table}:${row.on_delete}`).join(',');
const addColumn = (db, table, name, definition) => { if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); };
const repairImportTable = (db) => {
  const requiredUnique = 'runtime_key,kind,client_id,snapshot_hash';
  const requiredColumns = { commit_generation: 'INTEGER', commit_activation_epoch: 'INTEGER', commit_added: 'INTEGER', commit_manifest_hash: 'TEXT', commit_revision: 'INTEGER' };
  for (const [column, definition] of Object.entries(requiredColumns)) addColumn(db, 'queue_import', column, definition);
  db.exec("UPDATE queue_import SET commit_added=item_count,commit_manifest_hash=manifest_hash WHERE state='committed' AND (commit_added IS NULL OR commit_manifest_hash IS NULL)");
  const indexes = db.prepare('PRAGMA index_list(queue_import)').all();
  const current = indexes.find((row) => row.name === 'queue_import_active_snapshot_unique');
  const hasCurrentUnique = current?.unique && current.partial && db.prepare(`PRAGMA index_info(${current.name})`).all().map((entry) => entry.name).join(',') === requiredUnique;
  if (!hasCurrentUnique && current) db.exec('DROP INDEX queue_import_active_snapshot_unique');
  if (!hasCurrentUnique) db.exec("CREATE UNIQUE INDEX queue_import_active_snapshot_unique ON queue_import(runtime_key,kind,client_id,snapshot_hash) WHERE state IN ('staging','sealed','committed')");
  db.exec('CREATE INDEX IF NOT EXISTS queue_import_runtime_state_expiry ON queue_import(runtime_key,state,expires_at)');
};

const createV1 = (db) => db.exec(`
  CREATE TABLE queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE worktree_lifecycle (runtime_key TEXT NOT NULL, directory TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active', 'deleting', 'deleted')), deletion_token TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (runtime_key, directory));
  CREATE TABLE queue_scope (scope_id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, directory TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), worktree_state TEXT NOT NULL CHECK(worktree_state IN ('active', 'deleting', 'deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(runtime_key, directory, session_id));
  CREATE TABLE queue_item (queue_item_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL REFERENCES queue_scope(scope_id) ON DELETE CASCADE, content TEXT NOT NULL CHECK(length(content) <= 200000), composer_document TEXT, send_config TEXT, position INTEGER NOT NULL CHECK(position >= 0), status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'retrying', 'reconciling', 'unresolved', 'failed')), row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE queue_attempt (queue_item_id TEXT PRIMARY KEY REFERENCES queue_item(queue_item_id) ON DELETE CASCADE, message_id TEXT NOT NULL UNIQUE, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), lease_owner TEXT, lease_token TEXT, lease_expires_at INTEGER, reconciliation_state TEXT, reconciled_at INTEGER, last_error_code TEXT);
  CREATE TABLE operation_receipt (runtime_key TEXT NOT NULL, request_id TEXT NOT NULL, operation_type TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, committed_revision INTEGER NOT NULL CHECK(committed_revision >= 0), created_at INTEGER NOT NULL, PRIMARY KEY (runtime_key, request_id));
  CREATE TABLE worktree_order (runtime_key TEXT NOT NULL, project_directory TEXT NOT NULL, ordered_paths TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), updated_at INTEGER NOT NULL, PRIMARY KEY(runtime_key, project_directory));
  CREATE INDEX queue_item_scope_position ON queue_item(scope_id, position, queue_item_id);
  CREATE INDEX queue_scope_runtime_directory ON queue_scope(runtime_key, directory);
`);

const migrateV1ToV2 = (db) => {
  addColumn(db, 'queue_item', 'due_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'queue_item', 'reconciliation_due_at', 'INTEGER');
  addColumn(db, 'queue_item', 'dispatch_generation', 'INTEGER');
  addColumn(db, 'queue_item', 'attachment_issues', 'TEXT NOT NULL DEFAULT \'[]\'');
  addColumn(db, 'queue_item', 'last_error_code', 'TEXT');
  addColumn(db, 'queue_item', 'completed_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'lease_generation', 'INTEGER');
  addColumn(db, 'queue_attempt', 'fence_generation', 'INTEGER');
  addColumn(db, 'queue_attempt', 'last_attempt_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'reconciliation_started_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'reconciliation_deadline_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'reconciliation_checks', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'queue_attempt', 'reconciliation_next_check_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'reconciliation_unavailable_checks', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'queue_attempt', 'edit_reservation_token', 'TEXT');
  addColumn(db, 'queue_attempt', 'edit_reservation_owner', 'TEXT');
  addColumn(db, 'queue_attempt', 'edit_reservation_expires_at', 'INTEGER');
  addColumn(db, 'queue_attempt', 'edit_reservation_generation', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_runtime (runtime_key TEXT PRIMARY KEY, authority TEXT NOT NULL CHECK(authority IN ('shadow','active','paused')) DEFAULT 'shadow', generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0), updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queue_attempt_history (attempt_id TEXT PRIMARY KEY, queue_item_id TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, lease_owner TEXT NOT NULL, lease_token TEXT NOT NULL, fence_generation INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, error_code TEXT, UNIQUE(queue_item_id, attempt_number), UNIQUE(message_id));
    CREATE TABLE IF NOT EXISTS queue_completion (operation_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, queue_item_id TEXT NOT NULL, runtime_key TEXT, source TEXT, attempt_number INTEGER, completed_at INTEGER NOT NULL, completion_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attachment_upload (upload_id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging','ready','expired')), upload_token TEXT NOT NULL UNIQUE, object_hash TEXT, storage_key TEXT, size_bytes INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, ready_at INTEGER);
    CREATE TABLE IF NOT EXISTS attachment_object (object_hash TEXT PRIMARY KEY, storage_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_referenced_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queue_attachment (queue_item_id TEXT NOT NULL REFERENCES queue_item(queue_item_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, upload_id TEXT REFERENCES attachment_upload(upload_id), object_hash TEXT REFERENCES attachment_object(object_hash), locator_kind TEXT NOT NULL CHECK(locator_kind IN ('upload','server_path')), locator_value TEXT, name TEXT, media_type TEXT, size_bytes INTEGER, attachment_id TEXT, occurrence_ref_id TEXT, filename TEXT, mime_type TEXT, source TEXT, locator TEXT, PRIMARY KEY(queue_item_id, ordinal));
    CREATE INDEX IF NOT EXISTS queue_item_claim_due ON queue_item(status, due_at, scope_id, position);
    CREATE INDEX IF NOT EXISTS queue_item_reconcile_due ON queue_item(status, reconciliation_due_at);
    CREATE INDEX IF NOT EXISTS queue_attempt_history_item ON queue_attempt_history(queue_item_id, attempt_number);
    CREATE INDEX IF NOT EXISTS queue_attachment_object ON queue_attachment(object_hash);
    CREATE INDEX IF NOT EXISTS attachment_upload_runtime_expiry ON attachment_upload(runtime_key, state, expires_at);
  `);
  const historySql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_attempt_history'").get()?.sql ?? '';
  if (/ON DELETE CASCADE/i.test(historySql)) {
    db.exec(`CREATE TABLE queue_attempt_history_repaired (attempt_id TEXT PRIMARY KEY, queue_item_id TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, lease_owner TEXT NOT NULL, lease_token TEXT NOT NULL, fence_generation INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, error_code TEXT, UNIQUE(queue_item_id, attempt_number), UNIQUE(message_id));
      INSERT INTO queue_attempt_history_repaired SELECT attempt_id,queue_item_id,operation_id,message_id,attempt_number,lease_owner,lease_token,fence_generation,started_at,finished_at,outcome,error_code FROM queue_attempt_history;
      DROP TABLE queue_attempt_history;
      ALTER TABLE queue_attempt_history_repaired RENAME TO queue_attempt_history;
      CREATE INDEX IF NOT EXISTS queue_attempt_history_item ON queue_attempt_history(queue_item_id, attempt_number);`);
  }
  db.prepare("UPDATE queue_meta SET value = ? WHERE key = 'schema_version'").run(String(MESSAGE_QUEUE_SCHEMA_VERSION));
};

const migrateV2ToV3 = (db) => {
  addColumn(db, 'queue_runtime', 'activation_epoch', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'queue_runtime', 'activated_at', 'INTEGER');
  addColumn(db, 'queue_runtime', 'manifest_hash', 'TEXT');
  addColumn(db, 'queue_runtime', 'protocol', 'INTEGER NOT NULL DEFAULT 4');
  db.exec(`CREATE TABLE IF NOT EXISTS queue_import (import_id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('activation','late')), client_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL, item_count INTEGER NOT NULL CHECK(item_count >= 0), protocol INTEGER NOT NULL CHECK(protocol = 4), expected_generation INTEGER NOT NULL CHECK(expected_generation >= 0), state TEXT NOT NULL CHECK(state IN ('staging','sealed','committed','abandoned','expired')), manifest_hash TEXT, created_at INTEGER NOT NULL, sealed_at INTEGER, committed_at INTEGER, expires_at INTEGER NOT NULL, commit_generation INTEGER, commit_activation_epoch INTEGER, commit_added INTEGER, commit_manifest_hash TEXT, commit_revision INTEGER);
    CREATE TABLE IF NOT EXISTS queue_import_item (import_id TEXT NOT NULL REFERENCES queue_import(import_id) ON DELETE CASCADE, scope_ordinal INTEGER NOT NULL CHECK(scope_ordinal >= 0), item_ordinal INTEGER NOT NULL CHECK(item_ordinal >= 0), queue_item_id TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(import_id,scope_ordinal,item_ordinal), UNIQUE(import_id,queue_item_id), UNIQUE(import_id,operation_id), UNIQUE(import_id,message_id));
    CREATE INDEX IF NOT EXISTS queue_import_runtime_state_expiry ON queue_import(runtime_key,state,expires_at);
    CREATE INDEX IF NOT EXISTS queue_import_item_identity ON queue_import_item(queue_item_id,operation_id,message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS queue_import_active_snapshot_unique ON queue_import(runtime_key,kind,client_id,snapshot_hash) WHERE state IN ('staging','sealed','committed');`);
  db.prepare("UPDATE queue_meta SET value = ? WHERE key = 'schema_version'").run(String(MESSAGE_QUEUE_SCHEMA_VERSION));
};

const migrateV3ToV4 = (db) => {
  addColumn(db, 'queue_item', 'delivery_target', "TEXT NOT NULL DEFAULT '{\"kind\":\"primary\"}'");
  db.prepare("UPDATE queue_item SET delivery_target='{\"kind\":\"primary\"}' WHERE delivery_target IS NULL OR delivery_target='' ").run();
  db.prepare("UPDATE queue_meta SET value = ? WHERE key = 'schema_version'").run(String(MESSAGE_QUEUE_SCHEMA_VERSION));
};

const migrateV4ToV5 = (db) => {
  const rows = db.prepare('SELECT queue_item_id,delivery_target FROM queue_item').all();
  const primary = JSON.stringify({ kind: 'primary' });
  const malformed = [];
  const deliveryPart = (part) => {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) return null;
    if (part.type === 'text' && Object.keys(part).every((key) => key === 'type' || key === 'text') && typeof part.text === 'string' && part.text.length <= 200_000) return part;
    if (part.type === 'file' && Object.keys(part).every((key) => key === 'type' || key === 'mime' || key === 'url') && typeof part.mime === 'string' && part.mime.length > 0 && part.mime.length <= 512 && typeof part.url === 'string' && part.url.length > 0 && part.url.length <= 4_096) return part;
    return null;
  };
  const attachmentPart = (attachment) => {
    if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) return null;
    const existingFile = deliveryPart(attachment);
    if (existingFile?.type === 'file') return existingFile;
    const keys = Object.keys(attachment);
    const mime = typeof attachment.mime === 'string' ? attachment.mime : attachment.mimeType;
    if (!keys.every((key) => ['mime', 'mimeType', 'url'].includes(key)) || typeof mime !== 'string' || mime.length === 0 || mime.length > 512 || typeof attachment.url !== 'string' || attachment.url.length === 0 || attachment.url.length > 4_096) return null;
    return { type: 'file', mime, url: attachment.url };
  };
  for (const row of rows) {
    let target;
    try { target = row.delivery_target ? JSON.parse(row.delivery_target) : null; } catch { target = null; }
    if (target == null) db.prepare('UPDATE queue_item SET delivery_target=? WHERE queue_item_id=?').run(primary, row.queue_item_id);
    else if (target?.kind === 'assistant') {
      const parts = Array.isArray(target.parts) ? target.parts.map(deliveryPart) : null;
      const attachments = Array.isArray(target.attachments) ? target.attachments.map(attachmentPart) : null;
      const deliveryParts = parts && attachments ? [...parts, ...attachments] : null;
      if (typeof target.assistantID !== 'string' || !target.assistantID || !validAssistantDeliveryParts(deliveryParts)) malformed.push(row.queue_item_id);
      else {
        delete target.parts;
        delete target.attachments;
        target.deliveryParts = deliveryParts;
        db.prepare('UPDATE queue_item SET delivery_target=? WHERE queue_item_id=?').run(JSON.stringify(target), row.queue_item_id);
      }
    }
  }
  if (malformed.length) {
    const placeholders = malformed.map(() => '?').join(',');
    db.prepare(`UPDATE queue_item SET status='failed',last_error_code='malformed_target',manual_dispatch_requested=0,updated_at=updated_at WHERE queue_item_id IN (${placeholders})`).run(...malformed);
  }
  db.prepare("UPDATE queue_meta SET value = ? WHERE key = 'schema_version'").run(String(MESSAGE_QUEUE_SCHEMA_VERSION));
};

export const initializeMessageQueueSchema = (db) => {
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000'); db.pragma('synchronous = FULL');
  const tables = tableNames(db); const hasMeta = tables.has('queue_meta');
  const queueTables = [...tables].filter((name) => name.startsWith('queue_') || name.startsWith('worktree_'));
  if (!hasMeta && queueTables.length) throw schemaError('message_queue_invalid_schema');
  const stored = hasMeta ? db.prepare("SELECT value FROM queue_meta WHERE key = 'schema_version'").get()?.value : undefined;
  const version = stored === undefined ? 0 : Number(stored);
  if (!Number.isInteger(version) || version > MESSAGE_QUEUE_SCHEMA_VERSION) throw schemaError('message_queue_unsupported_schema');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasMeta) { createV1(db); db.prepare("INSERT INTO queue_meta(key,value) VALUES ('schema_version','1'),('global_revision','0')").run(); }
    const current = hasMeta ? version : 1;
    if (current !== 1 && current !== 2 && current !== 3 && current !== 4 && current !== 5) throw schemaError('message_queue_invalid_schema');
    if (!db.prepare("SELECT 1 FROM queue_meta WHERE key = 'global_revision'").get()) throw schemaError('message_queue_invalid_schema');
    if (current === 1) migrateV1ToV2(db);
    if (current === 2) {
      migrateV1ToV2(db);
      addColumn(db, 'queue_completion', 'runtime_key', 'TEXT');
      addColumn(db, 'queue_completion', 'source', 'TEXT');
      addColumn(db, 'queue_completion', 'attempt_number', 'INTEGER');
      addColumn(db, 'queue_attachment', 'attachment_id', 'TEXT');
      addColumn(db, 'queue_attachment', 'occurrence_ref_id', 'TEXT');
      addColumn(db, 'queue_attachment', 'filename', 'TEXT');
      addColumn(db, 'queue_attachment', 'mime_type', 'TEXT');
      addColumn(db, 'queue_attachment', 'source', 'TEXT');
      addColumn(db, 'queue_attachment', 'locator', 'TEXT');
      addColumn(db, 'queue_attempt', 'reconciliation_unavailable_checks', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'queue_runtime', 'authority', "TEXT NOT NULL DEFAULT 'shadow'");
      addColumn(db, 'queue_runtime', 'generation', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'queue_runtime', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'attachment_upload', 'runtime_key', 'TEXT');
      addColumn(db, 'attachment_upload', 'state', "TEXT NOT NULL DEFAULT 'staging'");
      addColumn(db, 'attachment_upload', 'upload_token', 'TEXT');
      addColumn(db, 'attachment_upload', 'object_hash', 'TEXT');
      addColumn(db, 'attachment_upload', 'storage_key', 'TEXT');
      addColumn(db, 'attachment_upload', 'size_bytes', 'INTEGER');
      addColumn(db, 'attachment_upload', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'attachment_upload', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'attachment_upload', 'ready_at', 'INTEGER');
      addColumn(db, 'attachment_object', 'storage_key', 'TEXT');
      addColumn(db, 'attachment_object', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'attachment_object', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'attachment_object', 'last_referenced_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'queue_attempt', 'edit_reservation_token', 'TEXT');
      addColumn(db, 'queue_attempt', 'edit_reservation_owner', 'TEXT');
      addColumn(db, 'queue_attempt', 'edit_reservation_expires_at', 'INTEGER');
      addColumn(db, 'queue_attempt', 'edit_reservation_generation', 'INTEGER');
    }
    if (current <= 2) migrateV2ToV3(db);
    if (current <= 3) migrateV3ToV4(db);
    if (current <= 4) migrateV4ToV5(db);
    repairImportTable(db);
    addColumn(db, 'queue_item', 'manual_dispatch_requested', 'INTEGER NOT NULL DEFAULT 0 CHECK(manual_dispatch_requested IN (0,1))');
    const required = { queue_meta: ['key', 'value'], queue_runtime: ['runtime_key', 'authority', 'generation', 'updated_at'], worktree_lifecycle: ['runtime_key', 'directory', 'state', 'deletion_token', 'updated_at'], queue_scope: ['scope_id', 'runtime_key', 'directory', 'session_id', 'revision', 'worktree_state', 'created_at', 'updated_at'], queue_item: ['queue_item_id', 'operation_id', 'scope_id', 'content', 'composer_document', 'send_config', 'position', 'status', 'row_version', 'created_at', 'updated_at', 'due_at', 'reconciliation_due_at', 'dispatch_generation', 'attachment_issues', 'last_error_code', 'completed_at'], queue_attempt: ['queue_item_id', 'message_id', 'attempt_count', 'lease_owner', 'lease_token', 'lease_expires_at', 'reconciliation_state', 'reconciled_at', 'last_error_code', 'lease_generation', 'fence_generation', 'last_attempt_at', 'reconciliation_started_at', 'reconciliation_deadline_at', 'reconciliation_checks', 'reconciliation_unavailable_checks', 'reconciliation_next_check_at', 'edit_reservation_token', 'edit_reservation_owner', 'edit_reservation_expires_at', 'edit_reservation_generation'], queue_attempt_history: ['attempt_id', 'queue_item_id', 'operation_id', 'message_id', 'attempt_number', 'lease_owner', 'lease_token', 'fence_generation', 'started_at', 'finished_at', 'outcome', 'error_code'], queue_completion: ['operation_id', 'message_id', 'queue_item_id', 'runtime_key', 'source', 'attempt_number', 'completed_at', 'completion_json'], operation_receipt: ['runtime_key', 'request_id', 'operation_type', 'payload_hash', 'response_json', 'committed_revision', 'created_at'], worktree_order: ['runtime_key', 'project_directory', 'ordered_paths', 'revision', 'updated_at'], attachment_upload: ['upload_id', 'runtime_key', 'state', 'upload_token', 'object_hash', 'storage_key', 'size_bytes', 'expires_at', 'created_at', 'ready_at'], attachment_object: ['object_hash', 'storage_key', 'size_bytes', 'created_at', 'last_referenced_at'], queue_attachment: ['queue_item_id', 'ordinal', 'upload_id', 'object_hash', 'locator_kind', 'locator_value', 'name', 'media_type', 'size_bytes', 'attachment_id', 'occurrence_ref_id', 'filename', 'mime_type', 'source', 'locator'] };
    required.queue_item.push('manual_dispatch_requested', 'delivery_target');
    for (const [table, fields] of Object.entries(required)) if (!tableNames(db).has(table) || fields.some((field) => !columns(db, table).has(field))) throw schemaError('message_queue_invalid_schema');
    const importRequired = { queue_runtime: ['activation_epoch', 'activated_at', 'manifest_hash', 'protocol'], queue_import: ['import_id', 'runtime_key', 'kind', 'client_id', 'snapshot_hash', 'item_count', 'protocol', 'expected_generation', 'state', 'manifest_hash', 'created_at', 'sealed_at', 'committed_at', 'expires_at', 'commit_generation', 'commit_activation_epoch', 'commit_added', 'commit_manifest_hash', 'commit_revision'], queue_import_item: ['import_id', 'scope_ordinal', 'item_ordinal', 'queue_item_id', 'operation_id', 'message_id', 'payload_json', 'payload_hash'] };
    for (const [table, fields] of Object.entries(importRequired)) if (!tableNames(db).has(table) || fields.some((field) => !columns(db, table).has(field))) throw schemaError('message_queue_invalid_schema');
    const uniqueRequired = { queue_item: ['operation_id'], queue_attempt: ['message_id'], queue_attempt_history: ['message_id', 'queue_item_id,attempt_number'], queue_completion: ['message_id'], attachment_upload: ['upload_token'] };
    for (const [table, entries] of Object.entries(uniqueRequired)) {
      const actual = uniqueColumns(db, table);
      if (entries.some((entry) => !actual.includes(entry))) throw schemaError('message_queue_invalid_schema');
    }
    const foreignRequired = { queue_item: 'scope_id:queue_scope:CASCADE', queue_attempt: 'queue_item_id:queue_item:CASCADE', queue_attachment: 'queue_item_id:queue_item:CASCADE', queue_attachment_upload: 'upload_id:attachment_upload:NO ACTION', queue_attachment_object: 'object_hash:attachment_object:NO ACTION', queue_import_item: 'import_id:queue_import:CASCADE' };
    for (const [table, entry] of Object.entries(foreignRequired)) { const owner = table.startsWith('queue_attachment_') ? 'queue_attachment' : table; if (!foreignKeys(db, owner).includes(entry)) throw schemaError('message_queue_invalid_schema'); }
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
    for (const index of ['queue_item_scope_position', 'queue_scope_runtime_directory', 'queue_item_claim_due', 'queue_item_reconcile_due', 'queue_attempt_history_item', 'queue_attachment_object', 'attachment_upload_runtime_expiry', 'queue_import_runtime_state_expiry', 'queue_import_item_identity']) if (!indexes.has(index)) throw schemaError('message_queue_invalid_schema');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); if (error?.code === 'message_queue_unsupported_schema' || error?.code === 'message_queue_invalid_schema') throw error; throw schemaError('message_queue_invalid_schema'); }
};
