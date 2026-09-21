import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createContactMemoryReader } from './memory.js';
import { bumpContactGeneration, clearContactMemory, contactHistoryForLlm, deleteContactMessages, ensureContactSchema, insertContactMessage } from './contact-store.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const databases = [];
afterEach(() => { while (databases.length) databases.pop().close(); });
const fixture = () => {
  const db = new Database(':memory:');
  databases.push(db);
  ensureContactSchema(db);
  let ordinal = 0;
  const insert = (messageID, text, { assistantID = 'a', role = 'user', turnID = messageID, ...extra } = {}) => {
    insertContactMessage(db, {
      messageID, assistantID, role, turnID, ordinal: ++ordinal, createdAt: 1_700_000_000_000 + ordinal,
      parts: [{ type: 'text', text }], ...extra,
    });
    return ordinal;
  };
  return { db, insert };
};

describe('contact memory boundaries', () => {
  it('forgets a preceding turn late reply while preserving queued users after clear-memory admission', () => {
    const { db, insert } = fixture();
    insert('prior', 'Old decision');
    const clearing = insert('clearing', 'Clear memory');
    insert('queued', 'New topic');
    insert('late-prior', 'Old decision details', { role: 'assistant', turnID: 'prior' });
    clearContactMemory(db, 'a', { upToOrdinal: clearing });
    insert('reset-confirm', 'Ready for a new topic', { role: 'assistant', turnID: 'clearing' });
    const reader = createContactMemoryReader(db, 'a');
    expect(reader.search().matches.map((m) => m.messageID)).toEqual(['reset-confirm', 'queued']);
    expect(() => reader.read({ messageID: 'late-prior' })).toThrow('memory_not_found');
    expect(contactHistoryForLlm(db, 'a').map((m) => m.content)).toEqual(['New topic', 'Ready for a new topic']);
  });

  it('scopes exact reads, search and cursors to one assistant and rejects target overrides', () => {
    const { db, insert } = fixture();
    insert('a1', 'needle own'); insert('a2', 'needle own later');
    insert('b1', 'needle other', { assistantID: 'b' });
    const a = createContactMemoryReader(db, 'a');
    const b = createContactMemoryReader(db, 'b');
    expect(a.search({ query: 'needle' }).matches.map((m) => m.messageID)).toEqual(['a2', 'a1']);
    expect(() => a.read({ messageID: 'b1' })).toThrow('memory_not_found');
    expect(() => a.search({ assistantID: 'b' })).toThrow('validation_error');
    expect(() => b.search({ query: 'needle', cursor: a.search({ query: 'needle', limit: 1 }).nextCursor })).toThrow('invalid_memory_cursor');
  });

  it('bounds scans and exposes empty partial pages until an older match is reached', () => {
    const { db, insert } = fixture();
    insert('old', 'rare decision');
    for (let i = 0; i < 410; i++) insert(`filler-${i}`, 'ordinary');
    const reader = createContactMemoryReader(db, 'a');
    let page = reader.search({ query: 'rare' });
    expect(page).toMatchObject({ matches: [], complete: false, scanned: 200 });
    page = reader.search({ query: 'rare', cursor: page.nextCursor });
    expect(page).toMatchObject({ matches: [], complete: false, scanned: 200 });
    page = reader.search({ query: 'rare', cursor: page.nextCursor });
    expect(page.matches.map((m) => m.messageID)).toEqual(['old']);
    expect(page.complete).toBe(true);
    expect(page.scanned).toBe(11);
  });

  it('paginates matching rows without gaps and returns literal, dated snippets', () => {
    const { db, insert } = fixture();
    for (let i = 0; i < 7; i++) insert(`match-${i}`, `100%_literal ${i}`);
    const reader = createContactMemoryReader(db, 'a');
    const ids = [];
    let cursor;
    do {
      const page = reader.search({ query: '%_', limit: 2, ...(cursor ? { cursor } : {}) });
      ids.push(...page.matches.map((m) => m.messageID));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['match-6', 'match-5', 'match-4', 'match-3', 'match-2', 'match-1', 'match-0']);
    const page = reader.search({ from: new Date(1_700_000_000_003).toISOString(), to: new Date(1_700_000_000_004).toISOString() });
    expect(page.matches.map((m) => m.messageID)).toEqual(['match-3', 'match-2']);
  });

  it('reads long Unicode messages by character offsets, including a match beyond the first chunk', () => {
    const { db, insert } = fixture();
    const text = '你好🙂'.repeat(2000) + 'rare ending';
    insert('long', text);
    const reader = createContactMemoryReader(db, 'a');
    const found = reader.search({ query: 'rare' }).matches[0];
    expect(found.snippet).toContain('rare ending');
    expect(found.offset).toBeGreaterThan(4000);
    let offset = 0;
    let recovered = '';
    do {
      const page = reader.read({ messageID: 'long', offset, maxChars: 997 });
      recovered += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(recovered).toBe(text);
    expect(() => reader.read({ messageID: 'long', offset: 99999 })).toThrow('validation_error');
  });

  it('invalidates captured readers and cursors on clear and wipe, retaining visible history only for clear', () => {
    const { db, insert } = fixture();
    insert('old-1', 'old'); insert('old-2', 'old');
    const reader = createContactMemoryReader(db, 'a');
    const cursor = reader.search({ limit: 1 }).nextCursor;
    clearContactMemory(db, 'a');
    expect(() => reader.search({ cursor })).toThrow('memory_scope_changed');
    expect(() => reader.read({ messageID: 'old-1' })).toThrow('memory_scope_changed');
    const fresh = createContactMemoryReader(db, 'a');
    expect(fresh.search().matches).toEqual([]);
    expect(() => fresh.read({ messageID: 'old-1' })).toThrow('memory_not_found');
    expect(() => fresh.search({ cursor })).toThrow('invalid_memory_cursor');
    deleteContactMessages(db, 'a'); bumpContactGeneration(db, 'a');
    expect(() => fresh.search()).toThrow('memory_scope_changed');
    expect(createContactMemoryReader(db, 'a').search().matches).toEqual([]);
  });

  it('excludes peers, errors, internal markers, attachment bodies and later queued admissions', () => {
    const { db, insert } = fixture();
    insert('visible', 'visible');
    const current = insert('current', 'current question');
    insert('queued', 'queued secret');
    insert('error', 'error secret', { role: 'assistant', status: 'error' });
    insert('peer', 'peer secret', { role: 'peer', fromAssistantID: 'b' });
    insert('internal', 'oc.settle.complete', { role: 'assistant' });
    insert('file', '', { parts: [{ type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,c2VjcmV0', filename: 'private.txt' }] });
    const reader = createContactMemoryReader(db, 'a', { beforeOrdinal: current });
    insert('future', 'future secret');
    expect(reader.search().matches.map((m) => m.messageID)).toEqual(['visible']);
    for (const id of ['current', 'queued', 'error', 'peer', 'internal', 'file', 'future']) expect(() => reader.read({ messageID: id })).toThrow('memory_not_found');
  });

  it('rejects malformed arguments and changed-filter cursors while database failures remain errors', () => {
    const { db, insert } = fixture();
    insert('one', 'needle'); insert('two', 'needle');
    const reader = createContactMemoryReader(db, 'a');
    for (const params of [{ limit: 21 }, { query: 1 }, { from: 'yesterday' }, { cursor: '{}' }, { cursor: 'bnVsbA' }]) expect(() => reader.search(params)).toThrow();
    const cursor = reader.search({ query: 'needle', limit: 1 }).nextCursor;
    expect(() => reader.search({ query: 'different', cursor })).toThrow('invalid_memory_cursor');
    db.exec('DROP TABLE assistant_contact_part');
    expect(() => reader.search()).toThrow();
    expect(() => reader.read({ messageID: 'one' })).toThrow();
  });

  it('migrates existing boundaries and rolls both watermarks back on failed transactions', () => {
    const { db, insert } = fixture();
    insert('old', 'old text');
    db.exec('ALTER TABLE assistant_contact_context_boundary DROP COLUMN assistant_after_ordinal');
    db.prepare('INSERT INTO assistant_contact_context_boundary VALUES (?,?,?)').run('a', 1, 1);
    ensureContactSchema(db);
    insert('new', 'new text');
    const reader = createContactMemoryReader(db, 'a');
    expect(reader.search().matches.map((m) => m.messageID)).toEqual(['new']);
    db.exec('BEGIN');
    clearContactMemory(db, 'a');
    db.exec('ROLLBACK');
    expect(reader.search().matches.map((m) => m.messageID)).toEqual(['new']);
  });
});
