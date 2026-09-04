import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createSessionCardPart } from './cards.js';
import {
  CONTACT_LLM_FILE_CHAR_WEIGHT,
  CONTACT_LLM_MAX_CHARS,
  CONTACT_LLM_MAX_TURNS,
  contactHistoryForLlm,
  deleteContactMessages,
  ensureContactSchema,
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
  insertContactMessage(db, {
    messageID,
    assistantID,
    role,
    turnID: messageID,
    bubbleIndex: 0,
    createdAt: Date.now(),
    ordinal: nextContactOrdinal(db, assistantID),
    status,
    parts: parts || (text ? [{ type: 'text', text }] : [{ type: 'text', text: '' }]),
    fromAssistantID,
    fromAssistantName,
  });
  return messageID;
};

describe('contact LLM history trim', () => {
  it('documents the budget constants in one place', () => {
    expect(CONTACT_LLM_MAX_TURNS).toBe(8);
    expect(CONTACT_LLM_MAX_CHARS).toBe(6_000);
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

  it('clears LLM history after deleteContactMessages', () => {
    const db = openDb();
    const assistantID = 'asst_reset';
    insert(db, assistantID, { role: 'user', text: 'before' });
    insert(db, assistantID, { role: 'assistant', text: 'reply' });
    deleteContactMessages(db, assistantID);
    expect(contactHistoryForLlm(db, assistantID)).toEqual([]);
    expect(listContactMessages(db, assistantID, { limit: 50 }).messages).toEqual([]);
    db.close();
  });
});
