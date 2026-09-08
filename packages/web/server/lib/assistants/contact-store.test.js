import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createSessionCardPart } from './cards.js';
import {
  CONTACT_LLM_FETCH_LIMIT,
  CONTACT_LLM_FILE_CHAR_WEIGHT,
  CONTACT_LLM_MAX_CHARS,
  CONTACT_LLM_MAX_TURNS,
  clearContactMemory,
  contactHistoryForLlm,
  deleteContactMessages,
  ensureContactSchema,
  getContactContextBoundary,
  insertContactMessage,
  listContactMessages,
  nextContactOrdinal,
  trimContactHistoryForLlm,
} from './contact-store.js';

const require = createRequire(import.meta.url);

const openDb = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-store-'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(directory, 'contact.sqlite'));
  ensureContactSchema(db);
  return db;
};

const insert = (db, assistantID, { role, text = '', parts, status = 'complete', fromAssistantID = null, fromAssistantName = null }) => {
  const messageID = crypto.randomUUID();
  const ordinal = nextContactOrdinal(db, assistantID);
  insertContactMessage(db, {
    messageID,
    assistantID,
    role,
    turnID: messageID,
    bubbleIndex: 0,
    createdAt: Date.now(),
    ordinal,
    status,
    parts: parts || (text ? [{ type: 'text', text }] : [{ type: 'text', text: '' }]),
    fromAssistantID,
    fromAssistantName,
  });
  return { messageID, ordinal };
};

describe('contact LLM history trim', () => {
  it('documents the budget constants in one place', () => {
    expect(CONTACT_LLM_MAX_TURNS).toBe(8);
    expect(CONTACT_LLM_MAX_CHARS).toBe(6_000);
    expect(CONTACT_LLM_FETCH_LIMIT).toBe(40);
    expect(CONTACT_LLM_FILE_CHAR_WEIGHT).toBe(80);
  });

  it('keeps the newest user+assistant turns and leaves older SQLite rows for the UI', () => {
    const db = openDb();
    const assistantID = 'asst_trim';
    for (let index = 0; index < 12; index += 1) {
      insert(db, assistantID, { role: 'user', text: `user-${index}` });
      insert(db, assistantID, { role: 'assistant', text: `assistant-${index}` });
    }
    const history = contactHistoryForLlm(db, assistantID);
    expect(history).toHaveLength(CONTACT_LLM_MAX_TURNS * 2);
    expect(history[0]).toEqual({ role: 'user', content: 'user-4' });
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'assistant-11' });
    const page = listContactMessages(db, assistantID, { limit: 100 });
    expect(page.messages).toHaveLength(24);
    expect(page.messages[0].text).toBe('user-0');
    db.close();
  });

  it('drops peer, error, and pure-card rows from the LLM window', () => {
    const db = openDb();
    const assistantID = 'asst_filter';
    insert(db, assistantID, { role: 'user', text: 'keep-user' });
    insert(db, assistantID, { role: 'assistant', text: 'keep-assistant' });
    insert(db, assistantID, { role: 'peer', text: 'secret-from-peer', fromAssistantID: 'other', fromAssistantName: 'PeerQA' });
    insert(db, assistantID, { role: 'assistant', text: 'failed', status: 'error' });
    insert(db, assistantID, {
      role: 'assistant',
      parts: [createSessionCardPart({ sessionID: 'ses_1', directory: '/repo', title: 'Work', status: 'busy' })],
    });
    expect(contactHistoryForLlm(db, assistantID)).toEqual([
      { role: 'user', content: 'keep-user' },
      { role: 'assistant', content: 'keep-assistant' },
    ]);
    expect(listContactMessages(db, assistantID, { limit: 50 }).messages).toHaveLength(5);
    db.close();
  });

  it('stops before an older turn that would exceed the char budget', () => {
    const huge = 'x'.repeat(CONTACT_LLM_MAX_CHARS - 10);
    const messages = [
      { role: 'user', status: 'complete', text: huge, parts: [{ type: 'text', text: huge }] },
      { role: 'assistant', status: 'complete', text: 'old-reply', parts: [{ type: 'text', text: 'old-reply' }] },
      { role: 'user', status: 'complete', text: 'recent', parts: [{ type: 'text', text: 'recent' }] },
      { role: 'assistant', status: 'complete', text: 'fresh', parts: [{ type: 'text', text: 'fresh' }] },
    ];
    expect(trimContactHistoryForLlm(messages)).toEqual([
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'fresh' },
    ]);
  });

  it('always keeps the newest turn even when it exceeds the char budget', () => {
    const huge = 'y'.repeat(CONTACT_LLM_MAX_CHARS + 200);
    const messages = [
      { role: 'user', status: 'complete', text: 'older', parts: [{ type: 'text', text: 'older' }] },
      { role: 'assistant', status: 'complete', text: 'older-reply', parts: [{ type: 'text', text: 'older-reply' }] },
      { role: 'user', status: 'complete', text: huge, parts: [{ type: 'text', text: huge }] },
      { role: 'assistant', status: 'complete', text: 'now', parts: [{ type: 'text', text: 'now' }] },
    ];
    expect(trimContactHistoryForLlm(messages)).toEqual([
      { role: 'user', content: huge },
      { role: 'assistant', content: 'now' },
    ]);
  });

  it('excludes later-admitted user rows past beforeOrdinal while keeping later assistant rows', () => {
    const db = openDb();
    const assistantID = 'asst_ceiling';
    insert(db, assistantID, { role: 'user', text: 'prior-user' });
    insert(db, assistantID, { role: 'assistant', text: 'prior-assistant' });
    const current = insert(db, assistantID, { role: 'user', text: 'current-turn' });
    insert(db, assistantID, { role: 'user', text: 'queued-later-user' });
    insert(db, assistantID, { role: 'assistant', text: 'prior-lane-assistant-after-admit' });
    expect(contactHistoryForLlm(db, assistantID, {
      excludeMessageIDs: [current.messageID],
      beforeOrdinal: current.ordinal,
    })).toEqual([
      { role: 'user', content: 'prior-user' },
      { role: 'assistant', content: 'prior-assistant' },
      { role: 'assistant', content: 'prior-lane-assistant-after-admit' },
    ]);
    db.close();
  });

  it('clears LLM history after deleteContactMessages', () => {
    const db = openDb();
    const assistantID = 'asst_reset';
    insert(db, assistantID, { role: 'user', text: 'before' });
    insert(db, assistantID, { role: 'assistant', text: 'reply' });
    deleteContactMessages(db, assistantID);
    expect(contactHistoryForLlm(db, assistantID)).toEqual([]);
    expect(listContactMessages(db, assistantID, { limit: 50 }).messages).toEqual([]);
    expect(getContactContextBoundary(db, assistantID)).toBe(0);
    db.close();
  });

  it('clearContactMemory keeps transcript rows and only advances the LLM boundary', () => {
    const db = openDb();
    const assistantID = 'asst_memory';
    insert(db, assistantID, { role: 'user', text: 'secret-before' });
    insert(db, assistantID, { role: 'assistant', text: 'remembered' });
    const cleared = clearContactMemory(db, assistantID, { updatedAt: 42 });
    expect(cleared).toMatchObject({ assistantID, memoryCleared: true, afterOrdinal: 2 });
    expect(getContactContextBoundary(db, assistantID)).toBe(2);
    expect(listContactMessages(db, assistantID, { limit: 50 }).messages.map((message) => message.text)).toEqual([
      'secret-before',
      'remembered',
    ]);
    expect(contactHistoryForLlm(db, assistantID)).toEqual([]);
    insert(db, assistantID, { role: 'user', text: 'after-clear' });
    insert(db, assistantID, { role: 'assistant', text: 'fresh-reply' });
    expect(contactHistoryForLlm(db, assistantID)).toEqual([
      { role: 'user', content: 'after-clear' },
      { role: 'assistant', content: 'fresh-reply' },
    ]);
    db.close();
  });

  it('clearContactMemory upToOrdinal does not swallow later-admitted queued users', () => {
    const db = openDb();
    const assistantID = 'asst_queue_waterline';
    insert(db, assistantID, { role: 'user', text: 'seed-secret' });
    insert(db, assistantID, { role: 'assistant', text: 'seed-reply' });
    const clearTurn = insert(db, assistantID, { role: 'user', text: '开新对话' });
    const queued = insert(db, assistantID, { role: 'user', text: 'queued-after-admit' });
    // Wrong: MAX would set afterOrdinal to queued.ordinal and permanently drop it.
    const cleared = clearContactMemory(db, assistantID, {
      updatedAt: 99,
      upToOrdinal: clearTurn.ordinal,
    });
    expect(cleared.afterOrdinal).toBe(clearTurn.ordinal);
    expect(getContactContextBoundary(db, assistantID)).toBe(clearTurn.ordinal);
    expect(contactHistoryForLlm(db, assistantID)).toEqual([
      { role: 'user', content: 'queued-after-admit' },
    ]);
    insert(db, assistantID, { role: 'assistant', text: 'queued-reply' });
    insert(db, assistantID, { role: 'user', text: 'later-follow-up' });
    const later = contactHistoryForLlm(db, assistantID);
    expect(later.some((item) => item.content.includes('seed-secret'))).toBe(false);
    expect(later.some((item) => item.content === 'queued-after-admit')).toBe(true);
    expect(later.some((item) => item.content === 'queued-reply')).toBe(true);
    expect(later.some((item) => item.content === 'later-follow-up')).toBe(true);
    expect(queued.ordinal).toBeGreaterThan(clearTurn.ordinal);
    db.close();
  });

  it('isolates context boundaries per assistant and survives reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-boundary-'));
    const Database = require('better-sqlite3');
    const dbPath = path.join(directory, 'contact.sqlite');
    const db = new Database(dbPath);
    ensureContactSchema(db);
    insert(db, 'asst_a', { role: 'user', text: 'a-secret' });
    insert(db, 'asst_a', { role: 'assistant', text: 'a-reply' });
    insert(db, 'asst_b', { role: 'user', text: 'b-secret' });
    insert(db, 'asst_b', { role: 'assistant', text: 'b-reply' });
    clearContactMemory(db, 'asst_a', { updatedAt: 1 });
    expect(contactHistoryForLlm(db, 'asst_a')).toEqual([]);
    expect(contactHistoryForLlm(db, 'asst_b')).toEqual([
      { role: 'user', content: 'b-secret' },
      { role: 'assistant', content: 'b-reply' },
    ]);
    db.close();
    const reopened = new Database(dbPath);
    ensureContactSchema(reopened);
    expect(getContactContextBoundary(reopened, 'asst_a')).toBe(2);
    expect(contactHistoryForLlm(reopened, 'asst_a')).toEqual([]);
    expect(listContactMessages(reopened, 'asst_a', { limit: 50 }).messages).toHaveLength(2);
    expect(contactHistoryForLlm(reopened, 'asst_b')).toEqual([
      { role: 'user', content: 'b-secret' },
      { role: 'assistant', content: 'b-reply' },
    ]);
    reopened.close();
  });

  it('keeps the previous boundary when clearContactMemory write fails inside a transaction', () => {
    const db = openDb();
    const assistantID = 'asst_fail';
    insert(db, assistantID, { role: 'user', text: 'first' });
    clearContactMemory(db, assistantID, { updatedAt: 10 });
    expect(getContactContextBoundary(db, assistantID)).toBe(1);
    insert(db, assistantID, { role: 'user', text: 'second' });
    insert(db, assistantID, { role: 'assistant', text: 'second-reply' });
    db.exec('BEGIN IMMEDIATE');
    try {
      clearContactMemory(db, assistantID, { updatedAt: 20 });
      throw new Error('forced_write_failure');
    } catch {
      db.exec('ROLLBACK');
    }
    expect(getContactContextBoundary(db, assistantID)).toBe(1);
    expect(contactHistoryForLlm(db, assistantID)).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second-reply' },
    ]);
    db.close();
  });
});
