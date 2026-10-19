import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_CACHE_CONTENT_TABLE,
  TRANSCRIPT_CACHE_INDEX_TABLE,
  TRANSCRIPT_CACHE_SCHEMA_VERSION,
  createTranscriptCacheService,
  projectContentSearchText,
} from './service.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCOPE = {
  transport: 'local',
  generation: 1,
  directory: '/workspace',
  sessionID: 'ses_1',
};

const otherScope = (patch) => ({ ...SCOPE, ...patch });

const userInfo = (id, created) => ({
  id,
  sessionID: SCOPE.sessionID,
  role: 'user',
  time: { created },
});

const assistantInfo = (id, created, settled = {}) => ({
  id,
  sessionID: SCOPE.sessionID,
  role: 'assistant',
  time: { created, ...(settled.completed !== undefined ? { completed: settled.completed } : {}) },
  ...(settled.finish ? { finish: settled.finish } : {}),
});

const textPart = (id, messageID, text, slim = false) => ({
  id,
  messageID,
  sessionID: SCOPE.sessionID,
  type: 'text',
  text,
  ...(slim ? { slim: true } : {}),
});

const idsOf = (records) => records.map((record) => record.messageID);

const tempDirectories = [];
const services = [];

const createService = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-transcript-cache-'));
  tempDirectories.push(directory);
  const dbPath = path.join(directory, 'transcript-cache.sqlite');
  const service = createTranscriptCacheService({ dbPath });
  services.push(service);
  return { service, dbPath };
};

const inspectTables = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const indexCount = db.prepare(`SELECT COUNT(*) AS count FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}`).get().count;
    const contentCount = db.prepare(`SELECT COUNT(*) AS count FROM ${TRANSCRIPT_CACHE_CONTENT_TABLE}`).get().count;
    return { tables, indexCount, contentCount };
  } finally {
    db.close();
  }
};

const writeUser = (service, id, created, text = id, scope = SCOPE) => (
  service.upsertSettled(scope, userInfo(id, created), [textPart(`${id}-p`, id, text)])
);

const writeAssistant = (service, id, created, input = {}, scope = SCOPE) => (
  service.upsertSettled(
    scope,
    assistantInfo(id, created, { finish: input.finish, completed: input.completed }),
    [textPart(`${id}-p`, id, input.text ?? 'done', input.slim === true)],
  )
);

afterEach(() => {
  while (services.length > 0) {
    try { services.pop()?.close(); } catch { /* temp files are removed below */ }
  }
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe('createTranscriptCacheService', () => {
  it('returns null when dbPath is empty so remote servers stay body-free', () => {
    expect(createTranscriptCacheService({})).toBeNull();
    expect(createTranscriptCacheService({ dbPath: '' })).toBeNull();
    expect(createTranscriptCacheService({ dbPath: '   ' })).toBeNull();
    expect(createTranscriptCacheService({ dbPath: null })).toBeNull();
  });

  it('creates the light index and JSON content tables', () => {
    const { service, dbPath } = createService();
    service.close();
    services.pop();
    const { tables } = inspectTables(dbPath);
    expect(tables.has(TRANSCRIPT_CACHE_INDEX_TABLE)).toBe(true);
    expect(tables.has(TRANSCRIPT_CACHE_CONTENT_TABLE)).toBe(true);
    expect(tables.has('transcript_cache_meta')).toBe(true);
  });

  it('rebuilds when the schema version does not match', () => {
    const { service, dbPath } = createService();
    expect(writeUser(service, 'msg_user', 10, 'hello').status).toBe('written');
    service.close();
    services.pop();

    const db = new Database(dbPath);
    db.prepare("UPDATE transcript_cache_meta SET value = ? WHERE key = 'schema_version'").run('0');
    db.close();

    const rebuilt = createTranscriptCacheService({ dbPath });
    services.push(rebuilt);
    expect(idsOf(rebuilt.readSession(SCOPE).records)).toEqual([]);
    rebuilt.close();
    services.pop();

    const inspected = inspectTables(dbPath);
    expect(inspected.tables.has(TRANSCRIPT_CACHE_INDEX_TABLE)).toBe(true);
    expect(inspected.tables.has(TRANSCRIPT_CACHE_CONTENT_TABLE)).toBe(true);
    const meta = new Database(dbPath, { readonly: true });
    expect(Number(meta.prepare("SELECT value FROM transcript_cache_meta WHERE key = 'schema_version'").get().value))
      .toBe(TRANSCRIPT_CACHE_SCHEMA_VERSION);
    meta.close();
  });
});

describe('transcript cache storage', () => {
  it('round-trips a settled message with derived hash, size, and per-part completeness', () => {
    const { service } = createService();
    const written = writeUser(service, 'msg_user', 10, 'hello');
    expect(written.status).toBe('written');
    expect(written.record.messageID).toBe('msg_user');
    expect(written.record.scope).toEqual(SCOPE);
    expect(written.record.completeness).toBe('full');
    expect(written.record.partCompleteness).toEqual(['full']);
    expect(written.record.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(written.record.byteSize).toBeGreaterThan(0);
    expect(written.record.sortKey).toEqual({ created: 10, messageID: 'msg_user' });

    const byId = service.readMessage(SCOPE, 'msg_user');
    expect(byId.info).toEqual(written.record.info);
    expect(byId.parts).toEqual(written.record.parts);
    expect(byId.contentHash).toBe(written.record.contentHash);

    const session = service.readSession(SCOPE);
    expect(idsOf(session.records)).toEqual(['msg_user']);
    expect(session.byteSize).toBe(session.records[0].byteSize);
  });

  it('skips an unchanged hash and refreshes lastAccessedAt', () => {
    const { service } = createService();
    const first = writeUser(service, 'msg_user', 10, 'hello');
    const second = writeUser(service, 'msg_user', 10, 'hello');
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('unchanged');
    expect(second.record.contentHash).toBe(first.record.contentHash);
    expect(second.record.byteSize).toBe(first.record.byteSize);
    expect(second.record.lastAccessedAt).toBeGreaterThan(first.record.lastAccessedAt);

    const changed = writeUser(service, 'msg_user', 10, 'hello-edited');
    expect(changed.status).toBe('written');
    expect(changed.record.contentHash).not.toEqual(first.record.contentHash);
  });

  it('keeps a full record when a later slim write arrives', () => {
    const { service } = createService();
    const full = writeAssistant(service, 'msg_asst', 20, { finish: 'stop', text: 'full body' });
    expect(full.record.completeness).toBe('full');

    const slim = writeAssistant(service, 'msg_asst', 20, { finish: 'stop', text: 'summary', slim: true });
    expect(slim.status).toBe('skipped');
    expect(slim.reason).toBe('slim-downgrade');
    expect(slim.record.completeness).toBe('full');
    expect(slim.record.parts).toEqual(full.record.parts);

    const kept = service.readMessage(SCOPE, 'msg_asst');
    expect(kept.completeness).toBe('full');
    expect(kept.parts[0].text).toBe('full body');
  });

  it('upgrades a slim record when a full write arrives', () => {
    const { service } = createService();
    const slim = writeAssistant(service, 'msg_asst', 20, { completed: 21, text: 'summary', slim: true });
    expect(slim.record.completeness).toBe('slim');
    expect(slim.record.partCompleteness).toEqual(['slim']);

    const full = writeAssistant(service, 'msg_asst', 20, { completed: 21, text: 'full body' });
    expect(full.status).toBe('written');
    expect(full.record.completeness).toBe('full');
    expect(full.record.partCompleteness).toEqual(['full']);
    expect(full.record.contentHash).not.toEqual(slim.record.contentHash);
  });

  it('rejects open assistants and persists users plus settled assistants', () => {
    const { service } = createService();
    expect(writeAssistant(service, 'msg_open', 30, { text: 'streaming' })).toEqual({
      status: 'skipped',
      reason: 'not-settled',
    });
    expect(service.readMessage(SCOPE, 'msg_open')).toBeUndefined();
    expect(writeUser(service, 'msg_user', 31).status).toBe('written');
    expect(writeAssistant(service, 'msg_finish', 32, { finish: 'stop' }).status).toBe('written');
    expect(writeAssistant(service, 'msg_done', 33, { completed: 34 }).status).toBe('written');
    expect(idsOf(service.readSession(SCOPE).records)).toEqual(['msg_user', 'msg_finish', 'msg_done']);
  });

  it('sorts by time.created then messageID', () => {
    const { service } = createService();
    writeUser(service, 'msg_z', 100);
    writeUser(service, 'msg_a', 200);
    writeUser(service, 'msg_m', 100);
    const session = service.readSession(SCOPE);
    expect(idsOf(session.records)).toEqual(['msg_m', 'msg_z', 'msg_a']);
  });

  it('isolates transport, generation, directory, and sessionID', () => {
    const { service } = createService();
    writeUser(service, 'msg_home', 10, 'home');
    writeUser(service, 'msg_transport', 10, 'other', otherScope({ transport: 'relay' }));
    writeUser(service, 'msg_generation', 10, 'other', otherScope({ generation: 2 }));
    writeUser(service, 'msg_directory', 10, 'other', otherScope({ directory: '/other' }));
    writeUser(service, 'msg_session', 10, 'other', otherScope({ sessionID: 'ses_2' }));

    expect(idsOf(service.readSession(SCOPE).records)).toEqual(['msg_home']);
    expect(idsOf(service.readSession(otherScope({ transport: 'relay' })).records)).toEqual(['msg_transport']);
    expect(idsOf(service.readSession(otherScope({ generation: 2 })).records)).toEqual(['msg_generation']);
    expect(idsOf(service.readSession(otherScope({ directory: '/other' })).records)).toEqual(['msg_directory']);
    expect(idsOf(service.readSession(otherScope({ sessionID: 'ses_2' })).records)).toEqual(['msg_session']);
  });

  it('cascade-deletes index and content together', () => {
    const { service, dbPath } = createService();
    writeUser(service, 'msg_a', 10);
    writeUser(service, 'msg_b', 20);
    service.close();
    services.pop();
    expect(inspectTables(dbPath)).toMatchObject({ indexCount: 2, contentCount: 2 });

    const reopened = createTranscriptCacheService({ dbPath });
    services.push(reopened);
    reopened.removeMessage(SCOPE, 'msg_b');
    reopened.removeMessage(SCOPE, 'msg_missing');
    expect(idsOf(reopened.readSession(SCOPE).records)).toEqual(['msg_a']);
    expect(reopened.readMessage(SCOPE, 'msg_b')).toBeUndefined();
    reopened.close();
    services.pop();
    expect(inspectTables(dbPath)).toMatchObject({ indexCount: 1, contentCount: 1 });
  });

  it('clears session and generation without crossing their boundaries', () => {
    const { service } = createService();
    writeUser(service, 'msg_keep_session', 10, 'keep', otherScope({ sessionID: 'ses_2' }));
    writeUser(service, 'msg_drop_session', 10);
    writeUser(service, 'msg_keep_generation', 10, 'keep', otherScope({ generation: 2 }));
    writeUser(service, 'msg_drop_generation', 11);

    service.clearSession(SCOPE);
    expect(idsOf(service.readSession(SCOPE).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ sessionID: 'ses_2' })).records)).toEqual(['msg_keep_session']);
    expect(idsOf(service.readSession(otherScope({ generation: 2 })).records)).toEqual(['msg_keep_generation']);

    writeUser(service, 'msg_gen1', 12);
    service.clearGeneration({ transport: SCOPE.transport, generation: 1 });
    expect(idsOf(service.readSession(SCOPE).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ sessionID: 'ses_2' })).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ generation: 2 })).records)).toEqual(['msg_keep_generation']);
  });

  it('evicts the least-recently accessed unprotected rows by byte budget', () => {
    const { service, dbPath } = createService();
    const first = writeUser(service, 'msg_old', 10, 'aaaaaaaa');
    const second = writeUser(service, 'msg_mid', 20, 'bbbbbbbb');
    const third = writeUser(service, 'msg_new', 30, 'cccccccc');
    expect(writeUser(service, 'msg_old', 10, 'aaaaaaaa').status).toBe('skipped');

    const budget = first.record.byteSize + third.record.byteSize;
    const evicted = service.evictToBytes(budget);
    expect(evicted.evicted).toBe(1);
    expect(evicted.freedBytes).toBe(second.record.byteSize);
    expect(evicted.remainingBytes).toBe(budget);
    expect(idsOf(service.readSession(SCOPE).records)).toEqual(['msg_old', 'msg_new']);
    expect(service.readMessage(SCOPE, 'msg_mid')).toBeUndefined();

    service.close();
    services.pop();
    expect(inspectTables(dbPath)).toMatchObject({ indexCount: 2, contentCount: 2 });
  });

  it('keeps protected scopes during eviction', () => {
    const { service } = createService();
    const kept = writeUser(service, 'msg_keep', 10, 'keep-keep', SCOPE);
    const dropped = writeUser(service, 'msg_drop', 20, 'drop-drop', otherScope({ sessionID: 'ses_2' }));
    const evicted = service.evictToBytes(0, { protect: [SCOPE] });
    expect(evicted.evicted).toBe(1);
    expect(evicted.freedBytes).toBe(dropped.record.byteSize);
    expect(evicted.remainingBytes).toBe(kept.record.byteSize);
    expect(idsOf(service.readSession(SCOPE).records)).toEqual(['msg_keep']);
    expect(service.readSession(otherScope({ sessionID: 'ses_2' })).records).toEqual([]);
  });

  it('clearAll empties both tables across every scope and stays writable', () => {
    const { service, dbPath } = createService();
    writeUser(service, 'msg_home', 10);
    writeUser(service, 'msg_transport', 10, 'other', otherScope({ transport: 'relay' }));
    writeUser(service, 'msg_generation', 10, 'other', otherScope({ generation: 2 }));
    writeUser(service, 'msg_directory', 10, 'other', otherScope({ directory: '/other' }));
    writeUser(service, 'msg_session', 10, 'other', otherScope({ sessionID: 'ses_2' }));

    service.clearAll();
    expect(idsOf(service.readSession(SCOPE).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ transport: 'relay' })).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ generation: 2 })).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ directory: '/other' })).records)).toEqual([]);
    expect(idsOf(service.readSession(otherScope({ sessionID: 'ses_2' })).records)).toEqual([]);
    expect(service.readMessage(SCOPE, 'msg_home')).toBeUndefined();

    service.close();
    services.pop();
    expect(inspectTables(dbPath)).toMatchObject({ indexCount: 0, contentCount: 0 });

    const reopened = createTranscriptCacheService({ dbPath });
    services.push(reopened);
    expect(writeUser(reopened, 'msg_again', 40, 'rewritten').status).toBe('written');
    expect(idsOf(reopened.readSession(SCOPE).records)).toEqual(['msg_again']);
    reopened.close();
    services.pop();
    expect(inspectTables(dbPath)).toMatchObject({ indexCount: 1, contentCount: 1 });
  });

  it('finds a constraint in the middle of a settled user message', () => {
    const { service } = createService();
    writeUser(
      service,
      'msg_prompt',
      10,
      'Please refactor the sync loop. The retry budget stays at three attempts. Then update the docs.',
    );

    expect(service.searchContent(SCOPE, 'retry budget')).toEqual({
      hits: [{
        sessionID: 'ses_1',
        messageID: 'msg_prompt',
        role: 'user',
        createdAt: 10,
        snippet: 'Please refactor the sync loop. The retry budget stays at three attempts. Then update the docs.',
      }],
    });
  });

  it('indexes the head and tail of a settled assistant reply and drops tool output and reasoning', () => {
    const { service } = createService();
    const head = 'H'.repeat(1024);
    const middle = 'MIDDLE-SECRET-NOT-INDEXED';
    const tail = 'T'.repeat(1024);
    const body = `${head}${middle}${tail}`;
    service.upsertSettled(
      SCOPE,
      assistantInfo('msg_reply', 20, { finish: 'stop' }),
      [
        { id: 'reason', messageID: 'msg_reply', sessionID: SCOPE.sessionID, type: 'reasoning', text: 'hidden-chain-of-thought' },
        { id: 'tool', messageID: 'msg_reply', sessionID: SCOPE.sessionID, type: 'tool', text: 'tool-dump-should-not-match' },
        { id: 'text', messageID: 'msg_reply', sessionID: SCOPE.sessionID, type: 'text', text: body },
      ],
    );

    const found = service.searchContent(SCOPE, 'HHHH');
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({
      sessionID: 'ses_1',
      messageID: 'msg_reply',
      role: 'assistant',
      createdAt: 20,
    });
    expect(found.hits[0].snippet.startsWith('H')).toBe(true);
    expect(service.searchContent(SCOPE, 'TTTT').hits).toHaveLength(1);
    expect(service.searchContent(SCOPE, 'MIDDLE-SECRET-NOT-INDEXED').hits).toEqual([]);
    expect(service.searchContent(SCOPE, 'hidden-chain-of-thought').hits).toEqual([]);
    expect(service.searchContent(SCOPE, 'tool-dump-should-not-match').hits).toEqual([]);
  });

  it('skips an open assistant turn and indexes it once the turn settles', () => {
    const { service } = createService();
    const open = service.upsertSettled(
      SCOPE,
      assistantInfo('msg_live', 30),
      [textPart('live', 'msg_live', 'still streaming the answer')],
    );
    expect(open).toMatchObject({ status: 'skipped', reason: 'not-settled' });
    expect(service.searchContent(SCOPE, 'streaming').hits).toEqual([]);

    service.upsertSettled(
      SCOPE,
      assistantInfo('msg_live', 30, { finish: 'stop' }),
      [textPart('live', 'msg_live', 'still streaming the answer')],
    );
    expect(service.searchContent(SCOPE, 'streaming').hits).toHaveLength(1);
  });

  it('replaces indexed text when the same message is edited and drops it when the message or session is removed', () => {
    const { service } = createService();
    writeUser(service, 'msg_edit', 40, 'use the old retry budget');
    writeUser(service, 'msg_edit', 40, 'use the new connection pool');
    expect(service.searchContent(SCOPE, 'retry budget').hits).toEqual([]);
    expect(service.searchContent(SCOPE, 'connection pool').hits).toHaveLength(1);

    service.removeMessage(SCOPE, 'msg_edit');
    expect(service.searchContent(SCOPE, 'connection pool').hits).toEqual([]);

    writeUser(service, 'msg_keep', 50, 'keep the session note');
    service.clearSession(SCOPE);
    expect(service.searchContent(SCOPE, 'session note').hits).toEqual([]);
  });

  it('returns no hits for a blank query, requires every term, and matches a Chinese substring', () => {
    const { service } = createService();
    writeUser(service, 'msg_zh', 60, '重试次数保持三次，连接池单独调');
    expect(service.searchContent(SCOPE, '   ').hits).toEqual([]);
    expect(service.searchContent(SCOPE, '重试 连接池').hits).toHaveLength(1);
    expect(service.searchContent(SCOPE, '重试 不存在').hits).toEqual([]);
    expect(service.searchContent(SCOPE, '次数').hits[0].snippet).toContain('重试次数');
  });

  it('rebuilds settled messages from the last seven days and skips older rows', () => {
    const { service, dbPath } = createService();
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    writeUser(service, 'msg_recent', now - 2 * 24 * 60 * 60 * 1000, 'recent retry budget');
    writeUser(service, 'msg_old', now - 10 * 24 * 60 * 60 * 1000, 'ancient retry budget');
    const raw = new Database(dbPath);
    raw.exec('DELETE FROM transcript_content_search');
    raw.close();
    expect(service.searchContent(SCOPE, 'retry budget').hits).toEqual([]);

    const result = service.rebuildContentSince(now - week);
    expect(result).toMatchObject({ scanned: 1, indexed: 1 });
    expect(service.searchContent(SCOPE, 'recent retry').hits.map((hit) => hit.messageID)).toEqual(['msg_recent']);
    expect(service.searchContent(SCOPE, 'ancient retry').hits).toEqual([]);
  });

  it('keeps a long assistant projection to the opening and closing edges', () => {
    const head = `HEAD-${'a'.repeat(1019)}`;
    const tail = `${'z'.repeat(1019)}-TAIL`;
    const text = `${head}${'m'.repeat(500)}${tail}`;
    expect(head).toHaveLength(1024);
    expect(tail).toHaveLength(1024);
    expect(projectContentSearchText(
      { role: 'assistant' },
      [{ type: 'text', text }],
    )).toBe(`${head}\n${tail}`);
  });
});
