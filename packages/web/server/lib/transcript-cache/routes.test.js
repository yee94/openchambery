import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerTranscriptCacheRoutes, TRANSCRIPT_CACHE_ROUTE_PREFIX as prefix } from './routes.js';

const registry = () => {
  const routes = new Map();
  return {
    app: {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
    },
    route: (method, path) => routes.get(`${method} ${path}`),
  };
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});

const SCOPE = {
  transport: 'local',
  generation: 1,
  directory: '/workspace',
  sessionID: 'ses_1',
};

const invoke = async (handler, req, res = response()) => {
  await handler(req, res);
  return res;
};

describe('transcript cache routes', () => {
  it('returns 501 when the service is disabled', async () => {
    const { app, route } = registry();
    registerTranscriptCacheRoutes(app, { transcriptCacheService: null });

    const session = await invoke(route('GET', `${prefix}/session`), { query: SCOPE });
    expect(session.statusCode).toBe(501);
    expect(session.body).toMatchObject({ error: expect.stringContaining('unavailable') });

    const upsert = await invoke(route('PUT', `${prefix}/message`), { body: { scope: SCOPE, info: { id: 'msg_1' }, parts: [] } });
    expect(upsert.statusCode).toBe(501);

    const evict = await invoke(route('POST', `${prefix}/evict`), { body: { maxBytes: 0 } });
    expect(evict.statusCode).toBe(501);

    const clearedAll = await invoke(route('DELETE', `${prefix}/all`), {});
    expect(clearedAll.statusCode).toBe(501);
    expect(clearedAll.body).toMatchObject({ error: expect.stringContaining('unavailable') });
  });

  it('rejects malformed scope, message ID, and body with 400', async () => {
    const { app, route } = registry();
    const transcriptCacheService = {
      readSession: vi.fn(),
      readMessage: vi.fn(),
      upsertSettled: vi.fn(),
      removeMessage: vi.fn(),
      clearSession: vi.fn(),
      clearGeneration: vi.fn(),
      evictToBytes: vi.fn(),
    };
    registerTranscriptCacheRoutes(app, { transcriptCacheService });

    const missingScope = await invoke(route('GET', `${prefix}/session`), { query: { sessionID: 'ses_1' } });
    expect(missingScope.statusCode).toBe(400);
    expect(transcriptCacheService.readSession).not.toHaveBeenCalled();

    const badGeneration = await invoke(route('GET', `${prefix}/session`), {
      query: { ...SCOPE, generation: '1.5' },
    });
    expect(badGeneration.statusCode).toBe(400);

    const missingMessageID = await invoke(route('GET', `${prefix}/message`), { query: SCOPE });
    expect(missingMessageID.statusCode).toBe(400);
    expect(transcriptCacheService.readMessage).not.toHaveBeenCalled();

    const badUpsert = await invoke(route('PUT', `${prefix}/message`), {
      body: { scope: SCOPE, info: { id: 'msg_1' }, parts: 'not-an-array' },
    });
    expect(badUpsert.statusCode).toBe(400);
    expect(transcriptCacheService.upsertSettled).not.toHaveBeenCalled();

    const badEvict = await invoke(route('POST', `${prefix}/evict`), { body: { maxBytes: 'nope' } });
    expect(badEvict.statusCode).toBe(400);
    expect(transcriptCacheService.evictToBytes).not.toHaveBeenCalled();
  });

  it('reads a session and a message through the OpenChamber prefix', async () => {
    const { app, route } = registry();
    const record = { messageID: 'msg_user', scope: SCOPE };
    const transcriptCacheService = {
      readSession: vi.fn(() => ({ scope: SCOPE, records: [record], byteSize: 12 })),
      readMessage: vi.fn(() => record),
    };
    registerTranscriptCacheRoutes(app, { transcriptCacheService });

    const session = await invoke(route('GET', `${prefix}/session`), { query: { ...SCOPE, generation: '1' } });
    expect(session.statusCode).toBe(200);
    expect(session.body).toEqual({ available: true, scope: SCOPE, records: [record], byteSize: 12 });
    expect(transcriptCacheService.readSession).toHaveBeenCalledWith(SCOPE);

    const message = await invoke(route('GET', `${prefix}/message`), { query: { ...SCOPE, messageID: 'msg_user' } });
    expect(message.statusCode).toBe(200);
    expect(message.body).toEqual({ available: true, record });
    expect(transcriptCacheService.readMessage).toHaveBeenCalledWith(SCOPE, 'msg_user');
  });

  it('returns 404 when a message is missing', async () => {
    const { app, route } = registry();
    registerTranscriptCacheRoutes(app, {
      transcriptCacheService: { readMessage: () => undefined },
    });
    const res = await invoke(route('GET', `${prefix}/message`), { query: { ...SCOPE, messageID: 'msg_missing' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'message_not_found' });
  });

  it('upserts, deletes, clears, and evicts through the service', async () => {
    const { app, route } = registry();
    const info = { id: 'msg_user', role: 'user', time: { created: 10 } };
    const parts = [{ id: 'p1', type: 'text', text: 'hello' }];
    const transcriptCacheService = {
      upsertSettled: vi.fn(() => ({ status: 'written', record: { messageID: 'msg_user' } })),
      removeMessage: vi.fn(),
      clearSession: vi.fn(),
      clearGeneration: vi.fn(),
      clearAll: vi.fn(),
      evictToBytes: vi.fn(() => ({ evicted: 1, freedBytes: 8, remainingBytes: 0 })),
    };
    registerTranscriptCacheRoutes(app, { transcriptCacheService });

    const upsert = await invoke(route('PUT', `${prefix}/message`), { body: { scope: SCOPE, info, parts } });
    expect(upsert.statusCode).toBe(200);
    expect(upsert.body).toEqual({ status: 'written', record: { messageID: 'msg_user' } });
    expect(transcriptCacheService.upsertSettled).toHaveBeenCalledWith(SCOPE, info, parts);

    const removed = await invoke(route('DELETE', `${prefix}/message`), { body: { scope: SCOPE, messageID: 'msg_user' } });
    expect(removed.statusCode).toBe(204);
    expect(transcriptCacheService.removeMessage).toHaveBeenCalledWith(SCOPE, 'msg_user');

    const clearedSession = await invoke(route('DELETE', `${prefix}/session`), { body: { scope: SCOPE } });
    expect(clearedSession.statusCode).toBe(204);
    expect(transcriptCacheService.clearSession).toHaveBeenCalledWith(SCOPE);

    const clearedGeneration = await invoke(route('DELETE', `${prefix}/generation`), {
      body: { transport: 'local', generation: 1 },
    });
    expect(clearedGeneration.statusCode).toBe(204);
    expect(transcriptCacheService.clearGeneration).toHaveBeenCalledWith({ transport: 'local', generation: 1 });

    const evicted = await invoke(route('POST', `${prefix}/evict`), {
      body: { maxBytes: 0, protect: [SCOPE] },
    });
    expect(evicted.statusCode).toBe(200);
    expect(evicted.body).toEqual({ evicted: 1, freedBytes: 8, remainingBytes: 0 });
    expect(transcriptCacheService.evictToBytes).toHaveBeenCalledWith(0, { protect: [SCOPE] });

    const clearedAll = await invoke(route('DELETE', `${prefix}/all`), {});
    expect(clearedAll.statusCode).toBe(204);
    expect(transcriptCacheService.clearAll).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON with 400 without touching the service', async () => {
    const app = express();
    const upsertSettled = vi.fn();
    registerTranscriptCacheRoutes(app, { transcriptCacheService: { upsertSettled } });

    const res = await request(app)
      .put(`${prefix}/message`)
      .set('Content-Type', 'application/json')
      .send('{"scope":');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Invalid') });
    expect(upsertSettled).not.toHaveBeenCalled();
  });

  it('rejects preview-proxy capability credentials with 403 and allows ordinary requests', async () => {
    const { app, route } = registry();
    const readSession = vi.fn(() => ({ scope: SCOPE, records: [], byteSize: 0 }));
    const upsertSettled = vi.fn(() => ({ status: 'written', record: { messageID: 'msg_user' } }));
    registerTranscriptCacheRoutes(app, { transcriptCacheService: { readSession, upsertSettled } });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queryToken = await invoke(route('GET', `${prefix}/session`), {
        query: { ...SCOPE, generation: '1' },
        originalUrl: `${prefix}/session?oc_preview_token=preview-secret`,
      });
      expect(queryToken.statusCode).toBe(403);
      expect(queryToken.body).toMatchObject({ error: 'Forbidden' });
      expect(queryToken.body).not.toMatchObject({ error: expect.stringContaining('preview-secret') });
      expect(readSession).not.toHaveBeenCalled();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('preview-secret');
    } finally {
      errorLog.mockRestore();
    }

    const cookieToken = await invoke(route('PUT', `${prefix}/message`), {
      body: { scope: SCOPE, info: { id: 'msg_user' }, parts: [] },
      url: `${prefix}/message`,
      headers: { cookie: 'oc_preview_token=preview-secret' },
    });
    expect(cookieToken.statusCode).toBe(403);
    expect(upsertSettled).not.toHaveBeenCalled();

    const allowed = await invoke(route('GET', `${prefix}/session`), {
      query: { ...SCOPE, generation: '1' },
      originalUrl: `${prefix}/session`,
    });
    expect(allowed.statusCode).toBe(200);
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it('does not log bodies, parts, or tokens when a request fails', async () => {
    const { app, route } = registry();
    registerTranscriptCacheRoutes(app, {
      transcriptCacheService: {
        upsertSettled: () => {
          throw new Error('secret body and token=abc');
        },
      },
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await invoke(route('PUT', `${prefix}/message`), {
        body: { scope: SCOPE, info: { id: 'msg_user' }, parts: [{ text: 'secret-body' }] },
      });
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret-body');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('token=abc');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret body');
    } finally {
      errorLog.mockRestore();
    }
  });
});
