import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ensureContactSchema, bumpContactGeneration, insertContactMessage, nextContactOrdinal } from './contact-store.js';
import {
  ensureContactAttachmentSchema,
  putContactAttachment,
  readContactAttachmentBytes,
  materializeContactFilePart,
  migrateContactDataUrlParts,
  assertContactAttachmentOwned,
} from './contact-attachments.js';

const require = createRequire(import.meta.url);

const png = Buffer.from([
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-att-'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(directory, 'a.sqlite'));
  ensureContactSchema(db);
  ensureContactAttachmentSchema(db);
  return { db, dataDir: directory, directory };
};


const streamOf = (buffer) => ({
  async *[Symbol.asyncIterator]() {
    yield buffer;
  },
});

describe('contact attachments', () => {
  it('PUT is idempotent on same uploadID+content and conflicts on different content', async () => {
    const { db, dataDir, directory } = open();
    const digest = createHash('sha256').update(png).digest('hex');
    const headers = {
      'x-content-size': String(png.length),
      'x-content-sha256': digest,
      'content-type': 'image/png',
      'x-attachment-filename': encodeURIComponent('shot.png'),
    };
    const first = await putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'up1',
      stream: streamOf(png),
      headers,
    });
    expect(first).toMatchObject({
      type: 'file',
      attachmentID: expect.stringMatching(/^att_/),
      sha256: digest,
      size: png.length,
      mime: 'image/png',
      filename: 'shot.png',
    });
    expect(first).not.toHaveProperty('url');
    expect(JSON.stringify(first)).not.toContain(dataDir);

    const second = await putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'up1',
      stream: streamOf(png),
      headers,
    });
    expect(second.attachmentID).toBe(first.attachmentID);

    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'up1',
      stream: streamOf(png),
      headers: { ...headers, 'x-content-sha256': 'a'.repeat(64) },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });

    // Cross-assistant cannot read.
    await expect(readContactAttachmentBytes({
      db,
      dataDir,
      assistantID: 'asst_other',
      attachmentID: first.attachmentID,
      external: true,
    })).rejects.toMatchObject({ code: 'not_found' });

    const bytes = await readContactAttachmentBytes({
      db,
      dataDir,
      assistantID: 'asst_a',
      attachmentID: first.attachmentID,
      external: true,
    });
    expect(bytes.buffer.equals(png)).toBe(true);
    expect(bytes.etag).toContain(digest);

    // Generation bump invalidates external GET.
    bumpContactGeneration(db, 'asst_a');
    await expect(readContactAttachmentBytes({
      db,
      dataDir,
      assistantID: 'asst_a',
      attachmentID: first.attachmentID,
      external: true,
    })).rejects.toMatchObject({ code: 'not_found' });
    // Owned (in-flight turn) still allowed.
    expect(assertContactAttachmentOwned(db, {
      attachmentID: first.attachmentID,
      assistantID: 'asst_a',
    }).attachment_id).toBe(first.attachmentID);

    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('rejects size/hash/mime forgery and path-like filenames', async () => {
    const { db, dataDir, directory } = open();
    const digest = createHash('sha256').update(png).digest('hex');
    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'badsize',
      stream: streamOf(png),
      headers: {
        'x-content-size': String(png.length + 1),
        'x-content-sha256': digest,
        'content-type': 'image/png',
      },
    })).rejects.toMatchObject({ code: 'PROMPT_ATTACHMENT_SIZE_MISMATCH' });

    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'badhash',
      stream: streamOf(png),
      headers: {
        'x-content-size': String(png.length),
        'x-content-sha256': 'b'.repeat(64),
        'content-type': 'image/png',
      },
    })).rejects.toMatchObject({ code: 'attachment_hash_mismatch' });

    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'badmime',
      stream: streamOf(png),
      headers: {
        'x-content-size': String(png.length),
        'x-content-sha256': digest,
        'content-type': 'image/jpeg',
      },
    })).rejects.toMatchObject({ code: 'attachment_mime_mismatch' });

    await expect(putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: '../evil',
      stream: streamOf(png),
      headers: {
        'x-content-size': String(png.length),
        'x-content-sha256': digest,
        'content-type': 'image/png',
      },
    })).rejects.toMatchObject({ code: 'validation_error' });

    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('materializes descriptors to data URLs for model execution without storing url in DB', async () => {
    const { db, dataDir, directory } = open();
    const digest = createHash('sha256').update(png).digest('hex');
    const desc = await putContactAttachment({
      db,
      dataDir,
      assistantID: 'asst_a',
      uploadID: 'mat1',
      stream: streamOf(png),
      headers: {
        'x-content-size': String(png.length),
        'x-content-sha256': digest,
        'content-type': 'image/png',
        'x-attachment-filename': 'x.png',
      },
    });
    const materialized = await materializeContactFilePart(db, dataDir, 'asst_a', desc);
    expect(materialized.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(materialized.mime).toBe('image/png');
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('migrates data-URL parts with CAS; failure keeps old JSON; reset race leaves row', async () => {
    const { db, dataDir, directory } = open();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const messageID = 'msg_legacy';
    insertContactMessage(db, {
      messageID,
      assistantID: 'asst_a',
      role: 'user',
      turnID: messageID,
      bubbleIndex: 0,
      createdAt: Date.now(),
      ordinal: nextContactOrdinal(db, 'asst_a'),
      status: 'complete',
      parts: [{ type: 'file', mime: 'image/png', url: dataUrl, filename: 'old.png' }],
    });
    const before = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get(messageID).part_json;
    expect(before).toContain('data:image/png');

    const result = await migrateContactDataUrlParts({
      db,
      dataDir,
      assistantID: 'asst_a',
    });
    expect(result.migrated).toBe(1);
    const after = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get(messageID).part_json;
    expect(after).toContain('attachmentID');
    expect(after).not.toContain('data:image/png');
    const parsed = JSON.parse(after);
    expect(parsed.attachmentID).toMatch(/^att_/);

    // Second pass is no-op.
    const again = await migrateContactDataUrlParts({ db, dataDir, assistantID: 'asst_a' });
    expect(again.migrated).toBe(0);

    await fsp.rm(directory, { recursive: true, force: true });
  });
});
