import { describe, expect, test } from 'vitest';

import { loadSessionIndexSnapshot, lookupSessionIndexById, pinSession } from './api';
import type { LynxHttpResponse } from '../connection/types';

const snapshot = {
  available: true,
  revision: 4,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/repo'],
    failedDirectories: [],
  },
  directories: [{
    directory: '/repo',
    cursor: null,
    hasMore: false,
    lastSyncedAt: 1,
    lastFullSyncedAt: 1,
    lastAccessedAt: 1,
    sessions: [{
      id: 'ses_1',
      title: 'Fix login',
      directory: '/repo',
      time: { created: 1, updated: 2 },
    }],
  }],
  pinnedSessionIds: ['ses_1'],
};

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('session-index API', () => {
  test('loads an authoritative snapshot from GET /api/openchamber/session-index', async () => {
    const result = await loadSessionIndexSnapshot(async (path) => {
      expect(path).toBe('/api/openchamber/session-index');
      return jsonResponse(200, snapshot);
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.revision).toBe(4);
    expect(result.snapshot.pinnedSessionIds).toEqual(['ses_1']);
  });

  test('treats 501 as unsupported, not an empty catalog', async () => {
    const result = await loadSessionIndexSnapshot(async () => jsonResponse(501, { error: 'unavailable' }));
    expect(result).toEqual({ status: 'unsupported' });
  });

  test('failed GET is failed, not an empty success', async () => {
    const result = await loadSessionIndexSnapshot(async () => jsonResponse(500, { error: 'boom' }));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.previous).toBeNull();
  });

  test('available:false is not an empty success', async () => {
    const result = await loadSessionIndexSnapshot(async () => jsonResponse(200, { available: false, directories: [] }));
    expect(result.status).toBe('failed');
  });

  test('lookup and pin use the real session-index routes', async () => {
    const paths: string[] = [];
    const fetch = async (path: string, init?: { method?: string }) => {
      paths.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('/session/ses_1') && !path.endsWith('/pin')) {
        return jsonResponse(200, { available: true, session: { id: 'ses_1', directory: '/repo', title: 'Fix login' } });
      }
      return jsonResponse(204, {});
    };
    expect(await lookupSessionIndexById(fetch, 'ses_1')).toEqual({
      id: 'ses_1',
      directory: '/repo',
      title: 'Fix login',
      parentID: null,
    });
    await pinSession(fetch, 'ses_1');
    expect(paths).toEqual([
      'GET /api/openchamber/session-index/session/ses_1',
      'POST /api/openchamber/session-index/session/ses_1/pin',
    ]);
  });
});
