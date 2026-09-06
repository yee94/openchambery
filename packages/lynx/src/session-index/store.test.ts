import { describe, expect, test } from 'vitest';

import { createMemoryKvStore } from '../connection/persist';
import { createLynxSessionIndexStore } from './store';
import type { SessionIndexSnapshot } from './types';
import type { LynxHttpResponse } from '../connection/types';

const okSnapshot: SessionIndexSnapshot = {
  revision: 2,
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
      title: 'Keep me',
      directory: '/repo',
      time: { created: 1, updated: 2 },
    }],
  }],
  pinnedSessionIds: [],
};

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('session-index store', () => {
  test('failed refresh preserves the previous snapshot', async () => {
    let fail = false;
    const store = createLynxSessionIndexStore({
      getRuntimeKey: () => 'runtime-a',
      storage: createMemoryKvStore(),
      runtimeFetch: async () => {
        if (fail) return jsonResponse(500, { error: 'down' });
        return jsonResponse(200, { available: true, ...okSnapshot });
      },
    });
    const first = await store.load();
    expect(first.status).toBe('ok');
    fail = true;
    const second = await store.refresh();
    expect(second.status).toBe('failed');
    if (second.status !== 'failed') return;
    expect(second.previous?.directories[0]?.sessions[0]?.id).toBe('ses_1');
    expect(store.getState().snapshot?.directories[0]?.sessions[0]?.id).toBe('ses_1');
    expect(store.getState().status).toBe('failed');
  });

  test('runtime switch clears in-memory rows so another instance cannot reuse them', async () => {
    let runtimeKey = 'runtime-a';
    const store = createLynxSessionIndexStore({
      getRuntimeKey: () => runtimeKey,
      storage: createMemoryKvStore(),
      runtimeFetch: async () => jsonResponse(200, { available: true, ...okSnapshot }),
    });
    await store.load();
    expect(store.getState().snapshot).not.toBeNull();
    runtimeKey = 'runtime-b';
    store.clearForRuntimeChange();
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().status).toBe('idle');
  });
});
