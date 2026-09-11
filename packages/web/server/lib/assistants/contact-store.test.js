import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  createAssistantCardPart,
  createScheduleCardPart,
  createSessionCardPart,
} from './cards.js';
import {
  CONTACT_LLM_FETCH_LIMIT,
  CONTACT_LLM_FILE_CHAR_WEIGHT,
  CONTACT_LLM_MAX_CHARS,
  CONTACT_LLM_MAX_TURNS,
  CONTACT_PAGE_DEFAULT_LIMIT,
  CONTACT_PAGE_MAX_LIMIT,
  CONTACT_PREVIEW_MAX_CHARS,
  CONTACT_SETTLE_TEXT,
  advanceContactReadWatermark,
  bumpContactGeneration,
  clearContactMemory,
  compareContactReadCursor,
  contactHistoryForLlm,
  countContactUnread,
  createActiveContactTurn,
  decodeContactCursor,
  deleteContactMessages,
  encodeContactCursor,
  ensureContactSchema,
  getContactContextBoundary,
  getContactGeneration,
  getContactReadTip,
  getContactReadWatermark,
  getContactUnreadSnapshots,
  getLatestContactMessagePreview,
  getLatestContactMessagePreviews,
  insertContactMessage,
  isContactUnreadCountableMessage,
  isContactVisiblePart,
  listContactMessages,
  migrateContactReadStateDefaultRead,
  nextContactOrdinal,
  projectActiveContactTurn,
  resetContactReadWatermarkForGeneration,
  sanitizeContactPreviewText,
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
    expect(CONTACT_LLM_MAX_TURNS).toBe(32);
    expect(CONTACT_LLM_MAX_CHARS).toBe(48_000);
    expect(CONTACT_LLM_FETCH_LIMIT).toBe(100);
    expect(CONTACT_LLM_FILE_CHAR_WEIGHT).toBe(80);
  });

  it('keeps the newest user+assistant turns and leaves older SQLite rows for the UI', () => {
    const db = openDb();
    const assistantID = 'asst_trim';
    for (let index = 0; index < 36; index += 1) {
      insert(db, assistantID, { role: 'user', text: `user-${index}` });
      insert(db, assistantID, { role: 'assistant', text: `assistant-${index}` });
    }
    const history = contactHistoryForLlm(db, assistantID);
    expect(history).toHaveLength(CONTACT_LLM_MAX_TURNS * 2);
    expect(history[0]).toEqual({ role: 'user', content: 'user-4' });
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'assistant-35' });
    const page = listContactMessages(db, assistantID, { limit: 100 });
    expect(page.messages).toHaveLength(72);
    expect(page.messages[0].text).toBe('user-0');
    db.close();
  });

  it('keeps card identity and drops peer and error rows from the LLM window', () => {
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
      { role: 'assistant', content: expect.stringContaining('\"sessionID\":\"ses_1\"') },
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

  it('deleteContactMessages upToOrdinal keeps wipe user + later users; drops late assistant/cards', () => {
    const db = openDb();
    const assistantID = 'asst_wipe_bound';
    insert(db, assistantID, { role: 'user', text: 'seed-old' });
    insert(db, assistantID, { role: 'assistant', text: 'seed-reply' });
    const wipeTurn = insert(db, assistantID, { role: 'user', text: '清空聊天记录' });
    const queued = insert(db, assistantID, {
      role: 'user',
      text: 'queued-B',
      parts: [{ type: 'text', text: 'queued-B' }, { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'b.txt' }],
    });
    // Late write from a prior still-running lane — ordinal after wipe user.
    insert(db, assistantID, { role: 'assistant', text: 'late-A-reply-should-die' });
    insert(db, assistantID, {
      role: 'assistant',
      text: '',
      parts: [createSessionCardPart({
        sessionID: 'ses_late_a',
        directory: '/repo',
        title: 'late A card',
        status: 'busy',
      })],
    });
    insert(db, assistantID, {
      role: 'peer',
      text: 'peer leftover',
      fromAssistantID: 'asst_other',
      fromAssistantName: 'Other',
    });
    deleteContactMessages(db, assistantID, { upToOrdinal: wipeTurn.ordinal });
    const page = listContactMessages(db, assistantID, { limit: 50 });
    expect(page.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: '清空聊天记录' },
      { role: 'user', text: 'queued-B' },
    ]);
    expect(page.messages[0].messageID).toBe(wipeTurn.messageID);
    expect(page.messages[1].messageID).toBe(queued.messageID);
    expect(page.messages[1].parts.some((part) => part.type === 'file' && part.filename === 'b.txt')).toBe(true);
    expect(page.messages.some((message) => message.cards?.length > 0)).toBe(false);
    expect(page.messages.some((message) => (message.text || '').includes('late-A'))).toBe(false);
    expect(page.messages.some((message) => message.role === 'peer')).toBe(false);
    expect(getContactContextBoundary(db, assistantID)).toBe(0);
    expect(contactHistoryForLlm(db, assistantID).some((item) => String(item.content).includes('late-A'))).toBe(false);
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

  it('projects the earliest active contact turn for snapshot recovery', () => {
    expect(createActiveContactTurn({ turnID: '', messageID: 'm', status: 'queued', admittedAt: 1 })).toBeNull();
    expect(createActiveContactTurn({ turnID: 't', messageID: 'm', status: 'settled', admittedAt: 1 })).toBeNull();
    const queued = createActiveContactTurn({ turnID: 't1', messageID: 'm1', status: 'queued', admittedAt: 20 });
    const running = createActiveContactTurn({ turnID: 't0', messageID: 'm0', status: 'running', admittedAt: 10 });
    expect(projectActiveContactTurn([queued, running])).toEqual(running);
    expect(projectActiveContactTurn(new Map([['t1', queued]]))).toEqual(queued);
    expect(projectActiveContactTurn([])).toBeNull();
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

describe('contact messages page keyset', () => {
  it('pages 45 rows as 20/20/5 with opaque cursors and ascending pages', () => {
    const db = openDb();
    const assistantID = 'asst_page';
    const ids = [];
    for (let i = 0; i < 45; i += 1) {
      ids.push(insert(db, assistantID, { role: i % 2 === 0 ? 'user' : 'assistant', text: `m-${i}` }).messageID);
    }
    expect(CONTACT_PAGE_DEFAULT_LIMIT).toBe(20);
    expect(CONTACT_PAGE_MAX_LIMIT).toBe(100);

    // First page is the newest window (chat tail), ascending within the page.
    const first = listContactMessages(db, assistantID, { limit: 20 });
    expect(first.messages).toHaveLength(20);
    expect(first.complete).toBe(false);
    expect(first.generation).toBe(0);
    expect(first.messages[0].text).toBe('m-25');
    expect(first.messages.at(-1).text).toBe('m-44');
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor1 = decodeContactCursor(first.nextCursor);
    expect(cursor1).toMatchObject({
      v: 1,
      assistantID,
      generation: 0,
      messageID: ids[25],
    });

    const second = listContactMessages(db, assistantID, { before: first.nextCursor, limit: 20 });
    expect(second.messages).toHaveLength(20);
    expect(second.complete).toBe(false);
    expect(second.messages[0].text).toBe('m-5');
    expect(second.messages.at(-1).text).toBe('m-24');

    const third = listContactMessages(db, assistantID, { before: second.nextCursor, limit: 20 });
    expect(third.messages).toHaveLength(5);
    expect(third.complete).toBe(true);
    expect(third.nextCursor).toBeNull();
    expect(third.messages.map((m) => m.text)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
    db.close();
  });

  it('rejects illegal cursors and cross-assistant cursor assistantID', () => {
    const db = openDb();
    insert(db, 'asst_a', { role: 'user', text: 'a' });
    insert(db, 'asst_b', { role: 'user', text: 'b' });
    expect(() => listContactMessages(db, 'asst_a', { before: 'not-base64!!!' })).toThrowError(
      expect.objectContaining({ code: 'validation_error' }),
    );
    const foreign = encodeContactCursor({
      assistantID: 'asst_b',
      generation: 0,
      ordinal: 1,
      messageID: 'x',
    });
    expect(() => listContactMessages(db, 'asst_a', { before: foreign })).toThrowError(
      expect.objectContaining({ code: 'validation_error' }),
    );
    expect(() => listContactMessages(db, 'asst_a', { before: 'x', messageID: 'y' })).toThrowError(
      expect.objectContaining({ code: 'validation_error' }),
    );
    db.close();
  });

  it('bumps generation on wipe path only; clear-memory keeps generation and cursors', () => {
    const db = openDb();
    const assistantID = 'asst_gen';
    for (let i = 0; i < 5; i += 1) insert(db, assistantID, { role: 'user', text: `g-${i}` });
    const page0 = listContactMessages(db, assistantID, { limit: 2 });
    expect(page0.generation).toBe(0);
    const cursor = page0.nextCursor;

    clearContactMemory(db, assistantID, { updatedAt: 1 });
    expect(getContactGeneration(db, assistantID)).toBe(0);
    expect(listContactMessages(db, assistantID, { before: cursor, limit: 2 }).messages).toHaveLength(2);

    expect(bumpContactGeneration(db, assistantID)).toBe(1);
    deleteContactMessages(db, assistantID);
    expect(getContactGeneration(db, assistantID)).toBe(1);
    expect(() => listContactMessages(db, assistantID, { before: cursor, limit: 2 })).toThrowError(
      expect.objectContaining({ code: 'contact_generation_conflict' }),
    );
    db.close();
  });

  it('exact messageID is assistant-scoped, missing returns empty, works past 100 rows', () => {
    const db = openDb();
    const assistantID = 'asst_exact';
    const other = 'asst_other';
    const ids = [];
    for (let i = 0; i < 120; i += 1) {
      ids.push(insert(db, assistantID, { role: 'user', text: `e-${i}` }).messageID);
    }
    const foreign = insert(db, other, { role: 'user', text: 'foreign' });

    const hit = listContactMessages(db, assistantID, { messageID: ids[110] });
    expect(hit).toMatchObject({
      nextCursor: null,
      complete: true,
      generation: 0,
    });
    expect(hit.messages).toHaveLength(1);
    expect(hit.messages[0].text).toBe('e-110');

    expect(listContactMessages(db, assistantID, { messageID: foreign.messageID }).messages).toEqual([]);
    expect(listContactMessages(db, assistantID, { messageID: 'missing_id' }).messages).toEqual([]);
    expect(listContactMessages(db, other, { messageID: foreign.messageID }).messages[0].text).toBe('foreign');
    db.close();
  });

  it('isolates pages across assistants under concurrent appends', () => {
    const db = openDb();
    for (let i = 0; i < 10; i += 1) {
      insert(db, 'asst_left', { role: 'user', text: `L-${i}` });
      insert(db, 'asst_right', { role: 'user', text: `R-${i}` });
    }
    const left = listContactMessages(db, 'asst_left', { limit: 5 });
    const right = listContactMessages(db, 'asst_right', { limit: 5 });
    expect(left.messages.every((m) => m.assistantID === 'asst_left')).toBe(true);
    expect(right.messages.every((m) => m.assistantID === 'asst_right')).toBe(true);
    // Newest window first.
    expect(left.messages.map((m) => m.text)).toEqual(['L-5', 'L-6', 'L-7', 'L-8', 'L-9']);
    insert(db, 'asst_left', { role: 'user', text: 'L-append' });
    const left2 = listContactMessages(db, 'asst_left', { before: left.nextCursor, limit: 5 });
    expect(left2.messages.map((m) => m.text)).toEqual(['L-0', 'L-1', 'L-2', 'L-3', 'L-4']);
    expect(listContactMessages(db, 'asst_right', { limit: 100 }).messages).toHaveLength(10);
    db.close();
  });
});

describe('contact latest message preview', () => {
  it('returns null when the assistant has no contact rows', () => {
    const db = openDb();
    expect(getLatestContactMessagePreview(db, 'asst_empty')).toBeNull();
    expect(getLatestContactMessagePreviews(db, ['asst_empty']).get('asst_empty')).toBeNull();
    db.close();
  });

  it('picks the newest user or assistant text by ordinal (not createdAt heuristics)', () => {
    const db = openDb();
    const assistantID = 'asst_preview_text';
    insert(db, assistantID, { role: 'user', text: 'older user' });
    insert(db, assistantID, { role: 'assistant', text: 'older assistant' });
    const latest = insert(db, assistantID, { role: 'user', text: 'newest user line' });
    expect(getLatestContactMessagePreview(db, assistantID)).toEqual({
      messageID: latest.messageID,
      ordinal: latest.ordinal,
      createdAt: latest.createdAt,
      role: 'user',
      text: 'newest user line',
      fallbackKind: null,
    });
    db.close();
  });

  it('skips settle-only markers and maps peer DM to user role', () => {
    const db = openDb();
    const assistantID = 'asst_preview_peer';
    insert(db, assistantID, { role: 'user', text: 'seed' });
    insert(db, assistantID, { role: 'assistant', text: CONTACT_SETTLE_TEXT.complete });
    const peer = insert(db, assistantID, {
      role: 'peer',
      text: 'hello from peer',
      fromAssistantID: 'asst_other',
      fromAssistantName: 'Other',
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toEqual({
      messageID: peer.messageID,
      ordinal: peer.ordinal,
      createdAt: peer.createdAt,
      role: 'user',
      text: 'hello from peer',
      fallbackKind: null,
    });
    db.close();
  });

  it('keeps durable error body text as the preview', () => {
    const db = openDb();
    const assistantID = 'asst_preview_err';
    insert(db, assistantID, { role: 'user', text: 'hi' });
    const err = insert(db, assistantID, {
      role: 'assistant',
      text: 'No connected model',
      status: 'error',
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      messageID: err.messageID,
      role: 'assistant',
      text: 'No connected model',
      fallbackKind: null,
    });
    db.close();
  });

  it('uses attachment and card fallbackKind when there is no spoken text', () => {
    const db = openDb();
    const assistantID = 'asst_preview_fb';
    insert(db, assistantID, {
      role: 'user',
      text: '',
      parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }],
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      role: 'user',
      text: 'shot.png',
      fallbackKind: 'image',
    });
    insert(db, assistantID, {
      role: 'user',
      text: '',
      parts: [{ type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,aa', filename: 'doc.pdf' }],
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      fallbackKind: 'file',
      text: 'doc.pdf',
    });
    insert(db, assistantID, {
      role: 'assistant',
      text: '',
      parts: [createSessionCardPart({
        sessionID: 'ses_1',
        directory: '/repo',
        title: 'Fix login',
        status: 'busy',
      })],
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      role: 'assistant',
      fallbackKind: 'session',
      text: 'Fix login',
    });
    insert(db, assistantID, {
      role: 'assistant',
      text: '',
      parts: [createAssistantCardPart({
        assistantID: 'asst_x',
        name: 'Flow',
        providerID: 'p',
        modelID: 'm',
      })],
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      fallbackKind: 'assistant',
      text: 'Flow',
    });
    insert(db, assistantID, {
      role: 'assistant',
      text: '',
      parts: [createScheduleCardPart({
        taskID: 'task_1',
        projectID: 'proj_1',
        name: 'Daily ping',
      })],
    });
    expect(getLatestContactMessagePreview(db, assistantID)).toMatchObject({
      fallbackKind: 'schedule',
      text: 'Daily ping',
    });
    db.close();
  });

  it('bounds and sanitizes long / base64 text', () => {
    const db = openDb();
    const assistantID = 'asst_preview_bound';
    const long = `hello ${'字'.repeat(CONTACT_PREVIEW_MAX_CHARS + 80)}`;
    const dirty = `see data:image/png;base64,${'A'.repeat(80)} trailing`;
    expect(sanitizeContactPreviewText(long).length).toBeLessThanOrEqual(CONTACT_PREVIEW_MAX_CHARS);
    expect(sanitizeContactPreviewText(dirty)).not.toContain('base64');
    insert(db, assistantID, { role: 'assistant', text: long });
    const preview = getLatestContactMessagePreview(db, assistantID);
    expect(preview.text.length).toBeLessThanOrEqual(CONTACT_PREVIEW_MAX_CHARS);
    expect(preview.text.startsWith('hello')).toBe(true);
    db.close();
  });

  it('batches previews across assistants without mixing identities', () => {
    const db = openDb();
    insert(db, 'asst_a', { role: 'user', text: 'from-a' });
    insert(db, 'asst_b', { role: 'assistant', text: 'from-b' });
    insert(db, 'asst_c', { role: 'user', text: 'unused' });
    deleteContactMessages(db, 'asst_c');
    const map = getLatestContactMessagePreviews(db, ['asst_a', 'asst_b', 'asst_c', 'asst_missing']);
    expect(map.get('asst_a').text).toBe('from-a');
    expect(map.get('asst_b').text).toBe('from-b');
    expect(map.get('asst_c')).toBeNull();
    expect(map.get('asst_missing')).toBeNull();
    db.close();
  });

  it('finds latest visible text after a long settle tail and large history without full-table rank', () => {
    const db = openDb();
    const assistantID = 'asst_preview_deep';
    for (let i = 0; i < 120; i += 1) {
      insert(db, assistantID, { role: 'user', text: `hist-${i}` });
      insert(db, assistantID, { role: 'assistant', text: `reply-${i}` });
    }
    const latest = insert(db, assistantID, { role: 'user', text: 'visible-after-settles' });
    // More settle markers than CONTACT_PREVIEW_CANDIDATE_LIMIT after the real message.
    for (let i = 0; i < 40; i += 1) {
      insert(db, assistantID, {
        role: 'assistant',
        text: CONTACT_SETTLE_TEXT.complete,
      });
      insert(db, assistantID, {
        role: 'assistant',
        text: CONTACT_SETTLE_TEXT.error,
      });
    }
    const preview = getLatestContactMessagePreview(db, assistantID);
    expect(preview).toMatchObject({
      messageID: latest.messageID,
      ordinal: latest.ordinal,
      createdAt: latest.createdAt,
      role: 'user',
      text: 'visible-after-settles',
      fallbackKind: null,
    });
    const batch = getLatestContactMessagePreviews(db, [assistantID, 'asst_other_empty']);
    expect(batch.get(assistantID)?.text).toBe('visible-after-settles');
    expect(batch.get('asst_other_empty')).toBeNull();

    // Probe must be an assistant_id range scan on the page index, not a full sort.
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT message_id, assistant_id, role, ordinal, status
       FROM assistant_contact_message m
       WHERE m.assistant_id = ?
         AND m.role IN ('user', 'assistant', 'peer')
       ORDER BY m.ordinal DESC, m.message_id DESC
       LIMIT ?`,
    ).all(assistantID, 24);
    const planText = plan.map((row) => `${row.detail || ''}`).join('\n').toLowerCase();
    expect(planText).toMatch(/assistant_contact_message/);
    // Must not be a whole-table SCAN without using the assistant_id path.
    expect(
      planText.includes('assistant_id')
      || planText.includes('assistant_contact_message_page')
      || planText.includes('using index')
      || planText.includes('search'),
    ).toBe(true);
    db.close();
  });
});

describe('contact read watermark / unread', () => {
  it('counts only complete/error assistant and peer replies; ignores user and settle-only', () => {
    expect(isContactVisiblePart({ type: 'text', text: 'hi' })).toBe(true);
    expect(isContactVisiblePart({ type: 'text', text: '  ' })).toBe(false);
    expect(isContactVisiblePart({ type: 'text', text: CONTACT_SETTLE_TEXT.complete })).toBe(false);
    expect(isContactVisiblePart({ type: 'file', mime: 'image/png' })).toBe(true);
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      text: 'hi',
      parts: [{ type: 'text', text: 'hi' }],
    })).toBe(true);
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'error',
      text: 'boom',
      parts: [{ type: 'text', text: 'boom' }],
    })).toBe(true);
    expect(isContactUnreadCountableMessage({
      role: 'peer',
      status: 'complete',
      text: 'dm',
      parts: [{ type: 'text', text: 'dm' }],
    })).toBe(true);
    expect(isContactUnreadCountableMessage({
      role: 'user',
      status: 'complete',
      text: 'me',
      parts: [{ type: 'text', text: 'me' }],
    })).toBe(false);
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      text: CONTACT_SETTLE_TEXT.complete,
      parts: [{ type: 'text', text: CONTACT_SETTLE_TEXT.complete }],
    })).toBe(false);
    // Blank / whitespace-only is not countable.
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [{ type: 'text', text: '' }],
    })).toBe(false);
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      text: '   ',
      parts: [{ type: 'text', text: '   ' }],
    })).toBe(false);
    // Settle beside real body still counts (per-part, not joined-text startsWith).
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      parts: [
        { type: 'text', text: CONTACT_SETTLE_TEXT.complete },
        { type: 'text', text: 'spoken summary' },
      ],
    })).toBe(true);
    // Settle prefix + file/card hybrid counts.
    expect(isContactUnreadCountableMessage({
      role: 'assistant',
      status: 'complete',
      parts: [
        { type: 'text', text: CONTACT_SETTLE_TEXT.error },
        { type: 'file', mime: 'text/plain', filename: 'a.txt' },
      ],
    })).toBe(true);

    const db = openDb();
    const assistantID = 'asst_unread_count';
    insert(db, assistantID, { role: 'user', text: 'u1' });
    insert(db, assistantID, { role: 'assistant', text: 'a1' });
    insert(db, assistantID, { role: 'assistant', text: CONTACT_SETTLE_TEXT.complete });
    insert(db, assistantID, { role: 'peer', text: 'p1', fromAssistantID: 'other', fromAssistantName: 'Peer' });
    insert(db, assistantID, { role: 'assistant', text: 'failed', status: 'error' });
    // No watermark → all countable unread.
    expect(countContactUnread(db, assistantID)).toBe(3);
    db.close();
  });

  it('SQL single/batch counts match visible-part rules for blank, settle prefix, and mixed parts', () => {
    const db = openDb();
    const assistantID = 'asst_unread_visible';
    insert(db, assistantID, { role: 'assistant', text: '' });
    insert(db, assistantID, { role: 'assistant', text: '   ' });
    insert(db, assistantID, { role: 'assistant', text: CONTACT_SETTLE_TEXT.complete });
    insert(db, assistantID, {
      role: 'assistant',
      parts: [
        { type: 'text', text: CONTACT_SETTLE_TEXT.question },
        { type: 'text', text: 'need your input' },
      ],
    });
    insert(db, assistantID, {
      role: 'assistant',
      parts: [
        { type: 'text', text: CONTACT_SETTLE_TEXT.complete },
        createSessionCardPart({
          sessionID: 'ses_visible',
          directory: '/tmp/proj',
          title: 'Work',
          status: 'complete',
        }),
      ],
    });
    insert(db, assistantID, { role: 'assistant', text: 'plain' });
    // blank×2 + settle-only excluded; mixed text, settle+card, plain → 3
    expect(countContactUnread(db, assistantID)).toBe(3);
    expect(getContactUnreadSnapshots(db, [assistantID]).get(assistantID)?.unreadCount).toBe(3);

    const tip = getContactReadTip(db, assistantID);
    advanceContactReadWatermark(db, assistantID, {
      generation: tip.generation,
      ordinal: tip.ordinal,
      messageID: tip.messageID,
    }, { updatedAt: 1 });
    expect(countContactUnread(db, assistantID)).toBe(0);
    expect(getContactUnreadSnapshots(db, [assistantID]).get(assistantID)?.unreadCount).toBe(0);
    db.close();
  });

  it('migrates legacy rows to default-read and only new messages count', () => {
    const db = openDb();
    const assistantID = 'asst_migrate_read';
    const a1 = insert(db, assistantID, { role: 'assistant', text: 'old-a' });
    const a2 = insert(db, assistantID, { role: 'assistant', text: 'old-b' });
    expect(countContactUnread(db, assistantID)).toBe(2);
    const migrated = migrateContactReadStateDefaultRead(db, { updatedAt: 1 });
    expect(migrated.seeded).toBe(1);
    expect(countContactUnread(db, assistantID)).toBe(0);
    const watermark = getContactReadWatermark(db, assistantID);
    expect(watermark).toMatchObject({
      ordinal: a2.ordinal,
      messageID: a2.messageID,
      generation: 0,
    });
    // Re-seed is idempotent.
    expect(migrateContactReadStateDefaultRead(db, { updatedAt: 2 }).seeded).toBe(0);

    insert(db, assistantID, { role: 'user', text: 'new-u' });
    const newer = insert(db, assistantID, { role: 'assistant', text: 'new-a' });
    expect(countContactUnread(db, assistantID)).toBe(1);
    expect(getContactReadTip(db, assistantID)).toMatchObject({
      ordinal: newer.ordinal,
      messageID: newer.messageID,
    });
    void a1;
    db.close();
  });

  it('advances monotonically, clamps to tip, and rejects stale generation', () => {
    const db = openDb();
    const assistantID = 'asst_mono';
    const first = insert(db, assistantID, { role: 'assistant', text: 'one' });
    const second = insert(db, assistantID, { role: 'assistant', text: 'two' });
    const third = insert(db, assistantID, { role: 'assistant', text: 'three' });

    const toFirst = advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: first.ordinal,
      messageID: first.messageID,
    }, { updatedAt: 10 });
    expect(toFirst.changed).toBe(true);
    expect(toFirst.unreadCount).toBe(2);

    // Equal → no-op.
    const same = advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: first.ordinal,
      messageID: first.messageID,
    }, { updatedAt: 11 });
    expect(same.changed).toBe(false);
    expect(same.unreadCount).toBe(2);

    // Late lower cursor cannot erase newer unread.
    const staleLower = advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: 0,
      messageID: '',
    }, { updatedAt: 12 });
    expect(staleLower.changed).toBe(false);
    expect(getContactReadWatermark(db, assistantID).ordinal).toBe(first.ordinal);

    // Forward to second.
    const toSecond = advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: second.ordinal,
      messageID: second.messageID,
    }, { updatedAt: 13 });
    expect(toSecond.changed).toBe(true);
    expect(toSecond.unreadCount).toBe(1);

    // Future cursor clamps to tip (third).
    const overshoot = advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: third.ordinal + 99,
      messageID: 'zzz_future',
    }, { updatedAt: 14 });
    expect(overshoot.changed).toBe(true);
    expect(overshoot.readWatermark).toMatchObject({
      ordinal: third.ordinal,
      messageID: third.messageID,
    });
    expect(overshoot.unreadCount).toBe(0);

    const generation = bumpContactGeneration(db, assistantID);
    expect(generation).toBe(1);
    resetContactReadWatermarkForGeneration(db, assistantID, generation, { updatedAt: 15 });
    expect(() => advanceContactReadWatermark(db, assistantID, {
      generation: 0,
      ordinal: third.ordinal,
      messageID: third.messageID,
    })).toThrow(expect.objectContaining({ code: 'contact_generation_conflict' }));

    // After generation reset, previous tip rows that remain are unread again.
    expect(countContactUnread(db, assistantID)).toBe(3);
    expect(compareContactReadCursor(
      { ordinal: 1, messageID: 'a' },
      { ordinal: 1, messageID: 'b' },
    )).toBeLessThan(0);
    db.close();
  });

  it('batches unread snapshots without per-assistant N+1 shape', () => {
    const db = openDb();
    const a = 'asst_batch_a';
    const b = 'asst_batch_b';
    insert(db, a, { role: 'assistant', text: 'a1' });
    insert(db, a, { role: 'assistant', text: 'a2' });
    insert(db, b, { role: 'peer', text: 'b1', fromAssistantID: 'x', fromAssistantName: 'X' });
    const batch = getContactUnreadSnapshots(db, [a, b, 'asst_empty']);
    expect(batch.get(a)?.unreadCount).toBe(2);
    expect(batch.get(b)?.unreadCount).toBe(1);
    expect(batch.get('asst_empty')?.unreadCount).toBe(0);
    expect(batch.get(a)?.readTip?.ordinal).toBeGreaterThan(0);
    expect(batch.get(a)?.readWatermark?.ordinal).toBe(0);
    db.close();
  });

  it('pushes watermark keyset into SQL so fully-read history does not scan parts (scale + plan)', () => {
    const db = openDb();
    const assistantID = 'asst_unread_scale';
    const otherID = 'asst_unread_scale_b';
    for (let i = 0; i < 240; i += 1) {
      insert(db, assistantID, { role: 'assistant', text: `hist-${i}` });
    }
    insert(db, otherID, { role: 'assistant', text: 'other-only' });
    const tip = getContactReadTip(db, assistantID);
    advanceContactReadWatermark(db, assistantID, {
      generation: tip.generation,
      ordinal: tip.ordinal,
      messageID: tip.messageID,
    }, { updatedAt: 1 });
    // Fully read: single + batch both 0; other assistant still 1.
    expect(countContactUnread(db, assistantID)).toBe(0);
    const fullyRead = getContactUnreadSnapshots(db, [assistantID, otherID]);
    expect(fullyRead.get(assistantID)?.unreadCount).toBe(0);
    expect(fullyRead.get(otherID)?.unreadCount).toBe(1);

    insert(db, assistantID, { role: 'assistant', text: CONTACT_SETTLE_TEXT.complete });
    insert(db, assistantID, { role: 'assistant', text: '' });
    insert(db, assistantID, { role: 'assistant', text: 'new-visible' });
    expect(countContactUnread(db, assistantID)).toBe(1);
    expect(getContactUnreadSnapshots(db, [assistantID]).get(assistantID)?.unreadCount).toBe(1);

    // Keyset-bounded probe must use the page index path (not a full-table sort of history).
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) AS count
       FROM assistant_contact_message m
       WHERE m.assistant_id = ?
         AND m.role IN ('assistant', 'peer')
         AND m.status IN ('complete', 'error')
         AND (m.ordinal > ? OR (m.ordinal = ? AND m.message_id > ?))`,
    ).all(assistantID, tip.ordinal, tip.ordinal, tip.messageID);
    const planText = plan.map((row) => `${row.detail || ''}`).join('\n').toLowerCase();
    expect(planText).toMatch(/assistant_contact_message/);
    expect(
      planText.includes('assistant_id')
      || planText.includes('assistant_contact_message_page')
      || planText.includes('using index')
      || planText.includes('search'),
    ).toBe(true);
    // Batch VALUES+join form also stays index-friendly on assistant_id.
    const batchPlan = db.prepare(
      `EXPLAIN QUERY PLAN
       WITH marks(assistant_id, mark_ordinal, mark_message_id) AS (VALUES (?, ?, ?))
       SELECT m.assistant_id, COUNT(*) AS count
       FROM assistant_contact_message m
       INNER JOIN marks ON marks.assistant_id = m.assistant_id
       WHERE m.role IN ('assistant', 'peer')
         AND m.status IN ('complete', 'error')
         AND (m.ordinal > marks.mark_ordinal
              OR (m.ordinal = marks.mark_ordinal AND m.message_id > marks.mark_message_id))
       GROUP BY m.assistant_id`,
    ).all(assistantID, tip.ordinal, tip.messageID);
    const batchPlanText = batchPlan.map((row) => `${row.detail || ''}`).join('\n').toLowerCase();
    expect(batchPlanText).toMatch(/assistant_contact_message/);
    db.close();
  });
});
