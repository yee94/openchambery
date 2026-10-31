import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  clearContactMemory,
  contactHistoryForLlm,
  ensureContactSchema,
  getContactSummary,
  insertContactMessage,
  nextContactOrdinal,
} from './contact-store.js';
import { ensureContactSummary } from './summary.js';

const require = createRequire(import.meta.url);
const openDb = () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'contact-summary-')), 'contact.sqlite'));
  ensureContactSchema(db);
  return db;
};
const add = (db, assistantID, role, text) => insertContactMessage(db, {
  messageID: crypto.randomUUID(), assistantID, role, turnID: crypto.randomUUID(), bubbleIndex: 0, createdAt: Date.now(),
  ordinal: nextContactOrdinal(db, assistantID), status: 'complete', parts: [{ type: 'text', text }],
});
const fill = (db, assistantID, turns) => {
  for (let index = 0; index < turns; index += 1) { add(db, assistantID, 'user', `user-${index}`); add(db, assistantID, 'assistant', `assistant-${index}`); }
};

describe('ensureContactSummary', () => {
  it('does nothing while the whole conversation still fits the window', async () => {
    const db = openDb();
    fill(db, 'a', 10);
    const complete = vi.fn();
    expect(await ensureContactSummary(db, 'a', { complete })).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    db.close();
  });

  it('summarizes only the turns that fell out and feeds the previous summary back in', async () => {
    const db = openDb();
    fill(db, 'a', 40);
    const complete = vi.fn(async () => 'summary v1');
    expect(await ensureContactSummary(db, 'a', { complete })).toBe(true);
    const first = complete.mock.calls[0][0];
    expect(first.user).toContain('(none)');
    expect(first.user).toContain('[user] user-0');
    const firstWindowStart = contactHistoryForLlm(db, 'a')[1].content;
    expect(firstWindowStart).not.toBe('user-0');
    expect(first.user).not.toContain(`[user] ${firstWindowStart}`);
    expect(contactHistoryForLlm(db, 'a')[0].content).toContain('summary v1');

    // Same window → no second model call.
    expect(await ensureContactSummary(db, 'a', { complete })).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);

    // Window jumps → incremental update reuses v1 as input.
    fill(db, 'a', 12);
    complete.mockResolvedValueOnce('summary v2');
    expect(await ensureContactSummary(db, 'a', { complete })).toBe(true);
    const second = complete.mock.calls[1][0];
    expect(second.user).toContain('summary v1');
    expect(second.user).not.toContain('[user] user-0\n');
    expect(getContactSummary(db, 'a').text).toBe('summary v2');
    db.close();
  });

  it('keeps the previous state when the model fails', async () => {
    const db = openDb();
    fill(db, 'a', 40);
    await expect(ensureContactSummary(db, 'a', { complete: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
    await expect(ensureContactSummary(db, 'a', { complete: async () => '   ' })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(getContactSummary(db, 'a')).toBeNull();
    db.close();
  });

  it('discards a summary when memory is cleared while the model call is in flight', async () => {
    const db = openDb();
    fill(db, 'a', 40);
    const complete = async () => { clearContactMemory(db, 'a'); return 'raced summary'; };
    expect(await ensureContactSummary(db, 'a', { complete })).toBe(false);
    expect(getContactSummary(db, 'a')).toBeNull();
    db.close();
  });
});
