import express from 'express';
import request from 'supertest';
import { expect, test, vi } from 'vitest';
import { registerContentSearchRoutes } from './routes.js';

test('global route returns coverage and preserves hit directories without a selected-project filter', async () => {
  const app = express();
  const hit = { sessionID: 's', messageID: 'm', title: 'Other project', directory: '/other', snippet: 'needle' };
  const search = vi.fn(() => [hit]);
  registerContentSearchRoutes(app, { contentSearch: {
    service: { search }, getRuntimeKey: () => 'host', runtime: { status: () => ({ phase: 'ready', messages: 1 }) },
  } });
  const response = await request(app).get('/api/openchamber/content-search').query({ q: 'needle' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ hits: [hit], index: { phase: 'ready', messages: 1 } });
  expect(search).toHaveBeenCalledWith('host', 'needle', { limit: 30, directory: undefined });
  expect((await request(app).get('/api/openchamber/content-search').query({ limit: -1 })).status).toBe(400);
  search.mockImplementation(() => { throw new Error('database unavailable'); });
  expect((await request(app).get('/api/openchamber/content-search').query({ q: 'needle' })).status).toBe(500);
});
