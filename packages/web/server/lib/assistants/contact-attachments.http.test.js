/**
 * Real express + core-routes binary middleware + assistants routes.
 * Isolated loopback / tempdir — no :3001, no user DB.
 *
 * Fixture layout (ephemeral):
 *   <tmpdir>/
 *     assistants-routes.sqlite
 *     prompt-attachments/   (content-addressed bytes via real fs store)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { isSafeInlineImageMime } from './contact-attachments.js';
import { AssistantError, createAssistantsService } from './service.js';

const require = createRequire(import.meta.url);

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'contact-att-http-'));
const closers = [];

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    closers.push(() => new Promise((done) => server.close(() => done())));
    resolve({ port, base: `http://127.0.0.1:${port}` });
  });
});

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

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

/** Production attachment route handlers + core-routes raw middleware + mocked contact harness. */
const buildApp = (directory, serviceOverrides = {}) => {
  const service = createAssistantsService({
    dbPath: path.join(directory, 'assistants-routes.sqlite'),
    dataDir: directory,
    getAllowedRoots: () => [directory],
    buildOpenCodeUrl: () => 'http://127.0.0.1:1',
    getOpenCodeAuthHeaders: () => ({}),
    clientFactory: () => ({
      session: {
        create: async () => ({ data: { id: 'ses_http' } }),
        get: async () => ({ data: { id: 'ses_http' } }),
        update: async () => ({ data: { id: 'ses_http' } }),
        promptAsync: async () => ({ response: { status: 204 } }),
        summarize: async () => ({ data: true }),
        delete: async () => ({ data: true }),
      },
      provider: { list: async () => ({ data: { connected: [] } }) },
      config: { providers: async () => ({ data: { providers: [] } }) },
    }),
    runContactTurn: async ({ userText }) => ({
      text: `ok:${userText}`,
      bubbles: [`ok:${userText}`],
    }),
    createChatCompletion: async () => ({ choices: [{ message: { content: 'x' } }] }),
    ...serviceOverrides,
  });
  closers.push(async () => service.close());
  service.setEnabled({ enabled: true, expectedRevision: service.snapshot().revision });

  const app = express();
  // Real core-routes binary exemption (must run before body parsers / attachment routes).
  registerCommonRequestMiddleware(app, { express });
  app.use((req, _res, next) => next());

  const respond = (res, work, success = 200) => Promise.resolve()
    .then(work)
    .then((body) => res.status(success).json(body))
    .catch((error) => {
      const code = error instanceof AssistantError ? error.code : error?.code || 'internal_error';
      const status = code === 'not_found' ? 404
        : ['revision_conflict', 'idempotency_conflict', 'contact_generation_conflict'].includes(code) ? 409
          : code === 'assistant_disabled' ? 403
            : code === 'PROMPT_ATTACHMENT_TOO_LARGE' ? 413
              : code === 'upstream_error' ? 502
                : 400;
      res.status(status).json({
        ok: false,
        error: code,
        message: typeof error?.message === 'string' && error.message.trim() ? error.message : code,
      });
    });

  // Same PUT/GET contract as packages/web/server/lib/assistants/routes.js
  app.put('/api/openchamber/assistants/:assistantID/contact/attachments/:uploadID', (req, res) => {
    const controller = new AbortController();
    req.once?.('aborted', () => controller.abort());
    respond(res, () => service.putAssistantContactAttachment(req.params.assistantID, req.params.uploadID, {
      stream: req,
      headers: req.headers,
      signal: controller.signal,
    }), 201);
  });
  app.get('/api/openchamber/assistants/:assistantID/contact/attachments/:attachmentID', (req, res) => {
    Promise.resolve()
      .then(() => service.getAssistantContactAttachment(req.params.assistantID, req.params.attachmentID))
      .then((file) => {
        res.status(200);
        res.setHeader('Content-Type', file.mime || 'application/octet-stream');
        res.setHeader('Content-Length', String(file.size));
        res.setHeader('ETag', file.etag || `"${file.sha256}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        const safeInline = isSafeInlineImageMime(file.mime);
        const name = file.filename ? encodeURIComponent(file.filename) : 'attachment';
        res.setHeader(
          'Content-Disposition',
          `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
        );
        res.end(file.buffer);
      })
      .catch((error) => {
        const code = error instanceof AssistantError ? error.code : error?.code || 'internal_error';
        const status = code === 'not_found' ? 404 : 400;
        res.status(status).json({ ok: false, error: code, message: error?.message || code });
      });
  });

  return { app, service, directory };
};

describe('contact attachments real HTTP (core-routes + assistants routes)', () => {
  it('PNG + application/json real PUT 201 → GET bytes/headers → send descriptor → page refs', async () => {
    const directory = mkRoot();
    closers.push(async () => fsp.rm(directory, { recursive: true, force: true }).catch(() => {}));
    const { app, service } = buildApp(directory);
    const { base } = await listen(app);

    const assistant = service.createAssistant({
      name: 'HTTP Att2',
      providerID: 'p',
      modelID: 'm',
    });

    const digest = createHash('sha256').update(realPng).digest('hex');
    const putRes = await fetch(
      `${base}/api/openchamber/assistants/${encodeURIComponent(assistant.id)}/contact/attachments/up_png1`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'X-Content-SHA256': digest,
          'X-Content-Size': String(realPng.length),
          'X-Attachment-Filename': encodeURIComponent('shot.png'),
        },
        body: realPng,
      },
    );
    const descriptor = await putRes.json();
    expect(putRes.status, JSON.stringify(descriptor)).toBe(201);
    expect(descriptor).toMatchObject({
      type: 'file',
      attachmentID: expect.stringMatching(/^att_/),
      sha256: digest,
      size: realPng.length,
      mime: 'image/png',
      filename: 'shot.png',
    });
    expect(JSON.stringify(descriptor)).not.toContain('prompt-attachments');
    expect(descriptor.url).toBeUndefined();

    // application/json Content-Type must keep raw bytes (not express.json-parsed).
    const jsonBytes = Buffer.from(JSON.stringify({ nested: true, blob: 'x'.repeat(64) }));
    const jsonDigest = createHash('sha256').update(jsonBytes).digest('hex');
    const putJson = await fetch(
      `${base}/api/openchamber/assistants/${encodeURIComponent(assistant.id)}/contact/attachments/up_json_raw`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Content-SHA256': jsonDigest,
          'X-Content-Size': String(jsonBytes.length),
          'X-Attachment-Filename': encodeURIComponent('payload.json'),
        },
        body: jsonBytes,
      },
    );
    const jsonDesc = await putJson.json();
    expect(putJson.status, JSON.stringify(jsonDesc)).toBe(201);
    expect(jsonDesc.sha256).toBe(jsonDigest);
    expect(jsonDesc.size).toBe(jsonBytes.length);
    expect(jsonDesc.mime).toBe('application/json');

    const sent = await service.send(assistant.id, {
      messageID: 'http_att_msg_1',
      parts: [
        { type: 'text', text: 'see image' },
        {
          type: 'file',
          mime: descriptor.mime,
          attachmentID: descriptor.attachmentID,
          sha256: descriptor.sha256,
          size: descriptor.size,
          filename: descriptor.filename,
        },
      ],
    });
    expect(sent.admitted).toBe(true);
    const settled = await service.whenContactTurnSettled(sent.messageID);
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'complete' });

    const page = service.contactMessages(assistant.id, { limit: 20 });
    const pageJson = JSON.stringify(page);
    expect(pageJson).not.toMatch(/data:image/);
    expect(pageJson).not.toMatch(/base64,[A-Za-z0-9+/]{20,}/);
    const user = page.messages.find((m) => m.role === 'user');
    expect(user.parts.some((p) => p.attachmentID === descriptor.attachmentID)).toBe(true);
    expect(user.parts.find((p) => p.attachmentID)?.url).toBeUndefined();

    const getPng = await fetch(
      `${base}/api/openchamber/assistants/${encodeURIComponent(assistant.id)}/contact/attachments/${encodeURIComponent(descriptor.attachmentID)}`,
    );
    expect(getPng.status).toBe(200);
    const gotPng = Buffer.from(await getPng.arrayBuffer());
    expect(gotPng.equals(realPng)).toBe(true);
    expect(getPng.headers.get('content-type')).toMatch(/image\/png/i);
    expect(getPng.headers.get('content-length')).toBe(String(realPng.length));
    expect(getPng.headers.get('etag')).toContain(digest);
    expect(getPng.headers.get('x-content-type-options')).toBe('nosniff');
    expect(getPng.headers.get('cache-control')).toMatch(/no-store/i);
    expect(getPng.headers.get('content-disposition')).toMatch(/^inline/i);

    const getJson = await fetch(
      `${base}/api/openchamber/assistants/${encodeURIComponent(assistant.id)}/contact/attachments/${encodeURIComponent(jsonDesc.attachmentID)}`,
    );
    expect(getJson.status).toBe(200);
    const gotJson = Buffer.from(await getJson.arrayBuffer());
    expect(gotJson.equals(jsonBytes)).toBe(true);
    expect(getJson.headers.get('content-disposition')).toMatch(/^attachment/i);
    expect(getJson.headers.get('cache-control')).toMatch(/no-store/i);

    expect(directory.startsWith(os.tmpdir()) || directory.includes('/T/')).toBe(true);
  });
});

describe('contact attachment materialize failure terminal settle', () => {
  it('deleting bytes after admit causes durable error, working=false, next turn ok', async () => {
    const directory = mkRoot();
    closers.push(async () => fsp.rm(directory, { recursive: true, force: true }).catch(() => {}));

    let materializeEntered = false;

    const service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'),
      dataDir: directory,
      getAllowedRoots: () => [directory],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1',
      getOpenCodeAuthHeaders: () => ({}),
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_m' } }),
          get: async () => ({ data: { id: 'ses_m' } }),
          update: async () => ({ data: { id: 'ses_m' } }),
          promptAsync: async () => ({ response: { status: 204 } }),
          summarize: async () => ({ data: true }),
          delete: async () => ({ data: true }),
        },
      }),
      runContactTurn: async () => {
        materializeEntered = true;
        return { text: 'should-not', bubbles: ['should-not'] };
      },
      createChatCompletion: async () => ({ choices: [{ message: { content: 'x' } }] }),
    });
    closers.push(async () => service.close());
    service.setEnabled({ enabled: true, expectedRevision: service.snapshot().revision });
    const assistant = service.createAssistant({ name: 'Fail Mat', providerID: 'p', modelID: 'm' });

    const digest = createHash('sha256').update(realPng).digest('hex');
    const descriptor = await service.putAssistantContactAttachment(assistant.id, 'up_fail1', {
      stream: { async *[Symbol.asyncIterator]() { yield realPng; } },
      headers: {
        'content-type': 'image/png',
        'x-content-sha256': digest,
        'x-content-size': String(realPng.length),
        'x-attachment-filename': 'gone.png',
      },
    });

    const storeRoot = path.join(directory, 'prompt-attachments');
    const found = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else found.push(full);
      }
    };
    if (fs.existsSync(storeRoot)) walk(storeRoot);
    expect(found.length).toBeGreaterThan(0);
    const filePath = found[0];
    fs.unlinkSync(filePath);
    expect(fs.existsSync(filePath)).toBe(false);

    const sent = await service.send(assistant.id, {
      messageID: 'msg_mat_fail',
      parts: [
        { type: 'text', text: 'with missing file' },
        {
          type: 'file',
          mime: 'image/png',
          attachmentID: descriptor.attachmentID,
          sha256: descriptor.sha256,
          size: descriptor.size,
          filename: 'gone.png',
        },
      ],
    });
    expect(sent.admitted).toBe(true);

    const settled = await service.whenContactTurnSettled('msg_mat_fail');
    expect(settled.status).toBe('error');
    expect(materializeEntered).toBe(false);

    const snap = service.snapshot().assistants.find((a) => a.id === assistant.id);
    expect(snap.working).toBe(false);
    expect(snap.activeContactTurn).toBeNull();

    const page = service.contactMessages(assistant.id, { limit: 20 });
    expect(page.messages.some((m) => m.status === 'error' || (m.role === 'assistant' && m.text))).toBe(true);
    const pageJson = JSON.stringify(page);
    expect(pageJson).not.toMatch(/data:image\/png;base64,[A-Za-z0-9+/]{40,}/);

    const next = await service.send(assistant.id, {
      messageID: 'msg_mat_next',
      parts: [{ type: 'text', text: 'plain next' }],
    });
    expect(next.admitted).toBe(true);
    const nextSettled = await service.whenContactTurnSettled('msg_mat_next');
    expect(nextSettled.status).toBe('complete');
    expect(service.snapshot().assistants.find((a) => a.id === assistant.id).working).toBe(false);
  });
});

describe('migration write failure + close cancel', () => {
  it('disk write failure inject leaves original part_json; sibling migrates', async () => {
    const { migrateContactDataUrlParts } = await import('./contact-attachments.js');
    const { ensureContactSchema, insertContactMessage, nextContactOrdinal } = await import('./contact-store.js');
    const { ensureContactAttachmentSchema } = await import('./contact-attachments.js');
    const { storePromptAttachmentBytes } = await import('../fs/prompt-attachment-store.js');
    const directory = mkRoot();
    closers.push(async () => fsp.rm(directory, { recursive: true, force: true }).catch(() => {}));
    const Database = require('better-sqlite3');
    const db = new Database(path.join(directory, 'm.sqlite'));
    ensureContactSchema(db);
    ensureContactAttachmentSchema(db);

    const goodUrl = `data:image/png;base64,${realPng.toString('base64')}`;
    insertContactMessage(db, {
      messageID: 'msg_disk_a',
      assistantID: 'asst_m',
      role: 'user',
      turnID: 'msg_disk_a',
      bubbleIndex: 0,
      createdAt: Date.now(),
      ordinal: nextContactOrdinal(db, 'asst_m'),
      status: 'complete',
      parts: [{ type: 'file', mime: 'image/png', url: goodUrl, filename: 'a.png' }],
    });
    insertContactMessage(db, {
      messageID: 'msg_disk_b',
      assistantID: 'asst_m',
      role: 'user',
      turnID: 'msg_disk_b',
      bubbleIndex: 0,
      createdAt: Date.now(),
      ordinal: nextContactOrdinal(db, 'asst_m'),
      status: 'complete',
      parts: [{ type: 'file', mime: 'image/png', url: goodUrl, filename: 'b.png' }],
    });
    const beforeA = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_a').part_json;
    let calls = 0;
    const result = await migrateContactDataUrlParts({
      db,
      dataDir: directory,
      assistantID: 'asst_m',
      storeBytes: async (args) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('EIO simulated');
          err.code = 'EIO';
          throw err;
        }
        return storePromptAttachmentBytes(args);
      },
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.failures.some((f) => f.error === 'EIO')).toBe(true);
    const afterA = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_a').part_json;
    expect(afterA).toBe(beforeA);
    expect(result.migrated).toBeGreaterThanOrEqual(1);
    const afterB = db.prepare('SELECT part_json FROM assistant_contact_part WHERE message_id=?').get('msg_disk_b').part_json;
    expect(afterB).toContain('attachmentID');
    expect(afterB).not.toContain('data:image/png;base64,');
    db.close();
  });

  it('service.close aborts in-flight migration controller', async () => {
    const directory = mkRoot();
    closers.push(async () => fsp.rm(directory, { recursive: true, force: true }).catch(() => {}));
    const service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'),
      dataDir: directory,
      getAllowedRoots: () => [directory],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1',
      getOpenCodeAuthHeaders: () => ({}),
      clientFactory: () => ({ session: { create: async () => ({ data: { id: 's' } }), get: async () => ({ data: { id: 's' } }), update: async () => ({ data: {} }), promptAsync: async () => ({ response: { status: 204 } }), summarize: async () => ({ data: true }), delete: async () => ({ data: true }) } }),
      runContactTurn: async () => ({ text: 'x', bubbles: ['x'] }),
      createChatCompletion: async () => ({ choices: [{ message: { content: 'x' } }] }),
    });
    expect(() => service.close()).not.toThrow();
    expect(() => service.close()).not.toThrow();
  });
});
