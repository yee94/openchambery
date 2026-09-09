/**
 * Isolated acceptance for server-authoritative contact working without touching :3001.
 * Exercises the same snapshot DTO shape HTTP clients pull after APP reload.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistantsService } from './service.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'contact-http-'));
const closers = [];

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    closers.push(() => new Promise((done) => server.close(() => done())));
    resolve({ port, base: `http://127.0.0.1:${port}` });
  });
});

const json = async (base, pathName, init = {}) => {
  const response = await fetch(`${base}${pathName}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

afterEach(async () => {
  while (closers.length) {
    await closers.pop()();
  }
});

describe('contact active turn HTTP snapshot (isolated)', () => {
  it('admission → running → settle is visible on snapshot GET; APP reload matches; missed-end idle poll converges', async () => {
    const directory = root();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'),
      dataDir: directory,
      getAllowedRoots: () => [directory],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1',
      getOpenCodeAuthHeaders: () => ({}),
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_x' } }),
          get: async () => ({ data: { id: 'ses_x' } }),
          update: async () => ({ data: { id: 'ses_x' } }),
          promptAsync: async () => ({ response: { status: 204 } }),
          summarize: async () => ({ data: true }),
          delete: async () => ({ data: true }),
        },
      }),
      runContactTurn: async () => {
        await blocked;
        return { text: 'done', bubbles: ['done'] };
      },
      createChatCompletion: async () => ({ choices: [{ message: { content: 'x' } }] }),
    });
    closers.push(async () => service.close());
    service.setEnabled({ enabled: true, expectedRevision: service.snapshot().revision });
    const assistant = service.createAssistant({
      name: 'HTTP Bot',
      providerID: 'p',
      modelID: 'm',
      defaultPrompt: '',
      mode: 'continuous',
    });

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.get('/api/openchamber/assistants/snapshot', (_req, res) => res.json(service.snapshot()));
    app.post('/api/openchamber/assistants/:id/messages', async (req, res) => {
      try {
        const body = await service.send(req.params.id, req.body);
        res.status(202).json(body);
      } catch (error) {
        res.status(400).json({ error: error.code || 'error', message: error.message });
      }
    });
    const { base } = await listen(app);

    // Fresh client: idle
    let snap = await json(base, '/api/openchamber/assistants/snapshot');
    expect(snap.status).toBe(200);
    expect(snap.body.assistants[0]).toMatchObject({
      id: assistant.id,
      working: false,
      activeContactTurn: null,
    });

    const admitted = await json(base, `/api/openchamber/assistants/${encodeURIComponent(assistant.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messageID: 'http_turn_1', parts: [{ type: 'text', text: 'hi' }] }),
    });
    expect(admitted.status).toBe(202);
    expect(admitted.body).toMatchObject({ admitted: true, messageID: 'http_turn_1', revision: expect.any(Number) });

    // Live client observes working after admit
    snap = await json(base, '/api/openchamber/assistants/snapshot');
    expect(snap.body.assistants[0].working).toBe(true);
    expect(snap.body.assistants[0].activeContactTurn).toMatchObject({
      turnID: 'http_turn_1',
      messageID: 'http_turn_1',
      status: expect.stringMatching(/^(queued|running)$/),
    });

    // APP reload / new client: same authoritative snapshot
    const reloaded = await json(base, '/api/openchamber/assistants/snapshot');
    expect(reloaded.body.assistants[0].working).toBe(true);
    expect(reloaded.body.assistants[0].activeContactTurn.turnID).toBe('http_turn_1');

    // Missed contact-turn-end: poll until idle
    release();
    await service.whenContactTurnSettled('http_turn_1');
    let idle = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      idle = await json(base, '/api/openchamber/assistants/snapshot');
      if (!idle.body.assistants[0].working) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(idle.body.assistants[0]).toMatchObject({
      working: false,
      activeContactTurn: null,
    });
  });
});
