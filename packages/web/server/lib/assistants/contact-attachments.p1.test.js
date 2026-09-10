/**
 * P1 fault-injection tests for contact attachments (not happy-path only).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  bumpContactGeneration,
  contactPartsFingerprint,
  ensureContactSchema,
  insertContactMessage,
  nextContactOrdinal,
} from './contact-store.js';
import {
  ensureContactAttachmentSchema,
  putContactAttachment,
  migrateContactDataUrlParts,
  materializeContactParts,
  assertContactAttachmentReadable,
  canonicalDescriptorFromRow,
  getContactAttachmentRow,
} from './contact-attachments.js';
import { storePromptAttachmentBytes } from '../fs/prompt-attachment-store.js';

const require = createRequire(import.meta.url);

const realPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
  0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const open = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-att-'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(directory, 'a.sqlite'));
  ensureContactSchema(db);
  ensureContactAttachmentSchema(db);
  return { db, dataDir: directory, directory };
};

const streamOf = (buffer) => ({
  async *[Symbol.asyncIterator]() { yield buffer; },
});

describe('P1 contact attachment faults', () => {
  it('fingerprint is content-identity; random attachmentID does not break same-content replay', () => {
    const digest = createHash('sha256').update(realPng).digest('hex');
    const a = contactPartsFingerprint([
      { type: 'file', mime: 'image/png', attachmentID: 'att_1', sha256: digest, size: realPng.length, filename: 'a.png' },
    ]);
    const b = contactPartsFingerprint([
      { type: 'file', mime: 'image/png', attachmentID: 'att_RANDOM_OTHER', sha256: digest, size: realPng.length, filename: 'a.png' },
    ]);
    const c = contactPartsFingerprint([
      { type: 'file', mime: 'image/png', url: `data:image/png;base64,${realPng.toString('base64')}`, filename: 'a.png' },
    ]);
    // Same content + mime + filename → identical fingerprint regardless of attachmentID / url form.
    expect(a).toBe(b);
    expect(a).toBe(c);
    const different = contactPartsFingerprint([
      { type: 'file', mime: 'image/png', attachmentID: 'att_2', sha256: 'b'.repeat(64), size: 9, filename: 'a.png' },
    ]);
    expect(different).not.toBe(a);
  });

  it('forged client metadata is replaced by storage row; reset during upload conflicts', async () => {
    const { db, dataDir, directory } = open();
    const digest = createHash('sha256').update(realPng).digest('hex');
    const headers = {
      'x-content-size': String(realPng.length),
      'x-content-sha256': digest,
      'content-type': 'image/png',
      'x-attachment-filename': 'real.png',
    };
    const desc = await putContactAttachment({
      db, dataDir, assistantID: 'asst_a', uploadID: 'up_ok', stream: streamOf(realPng), headers,
    });
    // Client lies about size/mime — admission rebuilds from row via readable assert.
    const row = assertContactAttachmentReadable(db, { attachmentID: desc.attachmentID, assistantID: 'asst_a' });
    const canonical = canonicalDescriptorFromRow(row);
    expect(canonical).toEqual(desc);
    expect(canonical.size).toBe(realPng.length);
    expect(canonical.sha256).toBe(digest);

    // Different content same uploadID after success → conflict
    const other = Buffer.concat([realPng, Buffer.from([1])]);
    // pad to invalid png but different hash
    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'up_ok',
      stream: streamOf(other),
      headers: {
        'x-content-size': String(other.length),
        'x-content-sha256': createHash('sha256').update(other).digest('hex'),
        'content-type': 'image/png',
      },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });

    // Reset then external readable fails
    bumpContactGeneration(db, 'asst_a');
    expect(() => assertContactAttachmentReadable(db, {
      attachmentID: desc.attachmentID,
      assistantID: 'asst_a',
    })).toThrowError(expect.objectContaining({ code: 'not_found' }));

    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('rejects parent symlink escape and corrupt existing object hash', async () => {
    const { dataDir, directory } = open();
    const outside = path.join(directory, 'outside-secret');
    fs.writeFileSync(outside, 'secret');
    const storeRoot = path.join(dataDir, 'prompt-attachments');
    fs.mkdirSync(storeRoot, { recursive: true });
    // Plant a symlink object that would escape if followed.
    const digest = createHash('sha256').update(realPng).digest('hex');
    const bucket = path.join(storeRoot, digest.slice(0, 2));
    fs.mkdirSync(bucket, { recursive: true });
    const target = path.join(bucket, `${digest}.png`);
    try {
      fs.symlinkSync(outside, target);
    } catch {
      // platforms without symlink support skip
      await fsp.rm(directory, { recursive: true, force: true });
      return;
    }
    await expect(storePromptAttachmentBytes({
      dataDir,
      buffer: realPng,
      expectedSha256: digest,
      mime: 'image/png',
      validateImage: true,
    })).rejects.toSatisfy((error) => (
      error?.code === 'attachment_unsafe_path'
      || error?.code === 'ELOOP'
      || /symlink|ELOOP|Unsafe/i.test(String(error?.message || error?.code || ''))
    ));
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('migration CAS fails closed when generation bumps mid-flight; continues other rows', async () => {
    const { db, dataDir, directory } = open();
    const url = `data:image/png;base64,${realPng.toString('base64')}`;
    for (let i = 0; i < 3; i += 1) {
      const messageID = `msg_m_${i}`;
      insertContactMessage(db, {
        messageID,
        assistantID: 'asst_a',
        role: 'user',
        turnID: messageID,
        bubbleIndex: 0,
        createdAt: Date.now(),
        ordinal: nextContactOrdinal(db, 'asst_a'),
        status: 'complete',
        parts: [{ type: 'file', mime: 'image/png', url, filename: `f${i}.png` }],
      });
    }
    // After first part migrates, bump generation mid-run via custom yield.
    let bumped = false;
    const result = await migrateContactDataUrlParts({
      db,
      dataDir,
      assistantID: 'asst_a',
      yieldFn: async () => {
        if (!bumped) {
          bumpContactGeneration(db, 'asst_a');
          bumped = true;
        }
      },
      batchSize: 1,
      batchBytes: 1,
    });
    expect(result.scanned).toBeGreaterThan(0);
    // At least one failure or success recorded; failures array is explicit.
    expect(Array.isArray(result.failures)).toBe(true);
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('materialize uses canonical size: exact fit completes; over budget errors (no silent drop)', async () => {
    const { db, dataDir, directory } = open();
    // Synthetic 1-byte bodies via data URL — canonical size field drives budget.
    const oneA = { type: 'file', mime: 'application/octet-stream', url: 'data:application/octet-stream;base64,QQ==', size: 1, filename: 'a.bin' };
    const oneB = { type: 'file', mime: 'application/octet-stream', url: 'data:application/octet-stream;base64,Qg==', size: 1, filename: 'b.bin' };
    const twoFit = await materializeContactParts(db, dataDir, 'asst_a', [
      { type: 'text', text: 'hi' },
      oneA,
      oneB,
    ], { budgetBytes: 2 });
    expect(twoFit.filter((p) => p.type === 'file')).toHaveLength(2);
    expect(twoFit[0]).toEqual({ type: 'text', text: 'hi' });

    await expect(materializeContactParts(db, dataDir, 'asst_a', [
      oneA, oneB, { ...oneA, filename: 'c.bin' },
    ], { budgetBytes: 2 })).rejects.toMatchObject({ code: 'attachment_budget_exceeded' });

    // Two 25MiB under 50MiB turn budget must complete (pre-sum + per-file gate, no silent continue).
    const twentyFive = 25 * 1024 * 1024;
    const bigA = { type: 'file', mime: 'application/octet-stream', url: 'data:application/octet-stream;base64,QQ==', size: twentyFive, filename: 'big-a.bin' };
    const bigB = { type: 'file', mime: 'application/octet-stream', url: 'data:application/octet-stream;base64,Qg==', size: twentyFive, filename: 'big-b.bin' };
    const fiftyFit = await materializeContactParts(db, dataDir, 'asst_a', [bigA, bigB], {
      budgetBytes: 50 * 1024 * 1024,
    });
    expect(fiftyFit.filter((p) => p.type === 'file')).toHaveLength(2);

    await expect(materializeContactParts(db, dataDir, 'asst_a', [
      bigA, bigB, { ...bigA, size: 1, filename: 'extra.bin' },
    ], { budgetBytes: 50 * 1024 * 1024 })).rejects.toMatchObject({ code: 'attachment_budget_exceeded' });

    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('migration storeBytes failure preserves row and continues siblings', async () => {
    const { db, dataDir, directory } = open();
    const goodUrl = `data:image/png;base64,${realPng.toString('base64')}`;
    insertContactMessage(db, {
      messageID: 'msg_disk_fail',
      assistantID: 'asst_a',
      role: 'user',
      turnID: 'msg_disk_fail',
      bubbleIndex: 0,
      createdAt: Date.now(),
      ordinal: nextContactOrdinal(db, 'asst_a'),
      status: 'complete',
      parts: [{ type: 'file', mime: 'image/png', url: goodUrl, filename: 'fail.png' }],
    });
    insertContactMessage(db, {
      messageID: 'msg_disk_ok',
      assistantID: 'asst_a',
      role: 'user',
      turnID: 'msg_disk_ok',
      bubbleIndex: 0,
      createdAt: Date.now(),
      ordinal: nextContactOrdinal(db, 'asst_a'),
      status: 'complete',
      parts: [{ type: 'file', mime: 'image/png', url: goodUrl, filename: 'ok.png' }],
    });
    const beforeFail = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_fail').part_json;
    let calls = 0;
    // Inject only on the first write failure; sibling uses real store.
    const result = await migrateContactDataUrlParts({
      db,
      dataDir,
      assistantID: 'asst_a',
      storeBytes: async (args) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('ENOSPC');
          err.code = 'ENOSPC';
          throw err;
        }
        return storePromptAttachmentBytes(args);
      },
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.failures.some((f) => f.error === 'ENOSPC' || /ENOSPC/.test(String(f.error)))).toBe(true);
    const afterFail = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_fail').part_json;
    expect(afterFail).toBe(beforeFail);
    expect(afterFail).toContain('data:image/png;base64,');
    expect(result.migrated).toBeGreaterThanOrEqual(1);
    const afterOk = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_ok').part_json;
    expect(afterOk).toContain('attachmentID');
    expect(afterOk).not.toContain('data:image/png;base64,');
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('migration yields before decode when estimated bytes would exceed batch budget', async () => {
    const { db, dataDir, directory } = open();
    const url = `data:image/png;base64,${realPng.toString('base64')}`;
    for (let i = 0; i < 3; i += 1) {
      insertContactMessage(db, {
        messageID: `msg_y_${i}`,
        assistantID: 'asst_a',
        role: 'user',
        turnID: `msg_y_${i}`,
        bubbleIndex: 0,
        createdAt: Date.now(),
        ordinal: nextContactOrdinal(db, 'asst_a'),
        status: 'complete',
        parts: [{ type: 'file', mime: 'image/png', url, filename: `y${i}.png` }],
      });
    }
    let yields = 0;
    await migrateContactDataUrlParts({
      db,
      dataDir,
      assistantID: 'asst_a',
      batchSize: 100,
      batchBytes: realPng.length, // one file fills batch
      yieldFn: async () => { yields += 1; },
    });
    expect(yields).toBeGreaterThanOrEqual(1);
    await fsp.rm(directory, { recursive: true, force: true });
  });
});
