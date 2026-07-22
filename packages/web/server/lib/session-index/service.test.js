import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionIndexService } from './service.js';

const tempDirectories = [];

const createService = (runtimeRef) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-index-'));
  tempDirectories.push(directory);
  return createSessionIndexService({
    dbPath: path.join(directory, 'session-index.sqlite'),
    getRuntimeConfig: () => ({ apiBaseUrl: runtimeRef.value }),
  });
};

const session = (id, updated, directory = '/repo') => ({
  id,
  title: `Session ${id}`,
  directory,
  time: { created: updated - 1, updated },
});

afterEach(() => {
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe('Electron session index', () => {
  it('stores one bounded root-session page transactionally', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    const sessions = Array.from({ length: 24 }, (_, index) => session(`ses_${index}`, 100 - index));

    service.replaceDirectory({ directory: '/repo', sessions, cursor: 80, hasMore: true, now: 1000 });

    const snapshot = service.snapshot();
    expect(snapshot.directories).toHaveLength(1);
    expect(snapshot.directories[0]).toMatchObject({
      directory: '/repo',
      cursor: 80,
      hasMore: true,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 1000,
    });
    expect(snapshot.directories[0].sessions).toHaveLength(20);
    expect(snapshot.directories[0].sessions[0].id).toBe('ses_0');
    service.close();
  });

  it('keeps Assistant-tagged OpenCode sessions in ordinary sidebar summaries', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    const assistantSession = {
      ...session('ses_assistant', 100),
      metadata: { openchamber: { assistant: { assistantID: 'assistant_1', name: 'A' } } },
    };

    service.replaceDirectory({ directory: '/repo', sessions: [assistantSession], cursor: null, hasMore: false });
    expect(service.snapshot().directories[0].sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ses_assistant' }),
    ]));
    service.close();
  });

  it('keeps runtime targets isolated in one Electron database', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: null, hasMore: false });

    runtimeRef.value = 'http://runtime-b.test';
    expect(service.snapshot().directories).toEqual([]);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_b', 11)], cursor: null, hasMore: false });
    expect(service.snapshot().directories[0].sessions[0].id).toBe('ses_b');

    runtimeRef.value = 'http://runtime-a.test';
    expect(service.snapshot().directories[0].sessions[0].id).toBe('ses_a');
    service.close();
  });

  it('replaces multiple directories in one transaction', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);

    service.replaceDirectories([
      { directory: '/repo/a', sessions: [session('ses_a', 10, '/repo/a')], cursor: null, hasMore: false },
      { directory: '/repo/b', sessions: [session('ses_b', 11, '/repo/b')], cursor: 9, hasMore: true },
    ], 1000);

    expect(service.snapshot().directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: '/repo/a', lastSyncedAt: 1000 }),
      expect.objectContaining({ directory: '/repo/b', cursor: 9, hasMore: true, lastSyncedAt: 1000 }),
    ]));
    service.close();
  });

  it('merges an SSE update without resetting page metadata', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: 8, hasMore: true, now: 1000 });

    service.upsert(session('ses_b', 11));

    expect(service.snapshot().directories[0]).toMatchObject({ cursor: 8, hasMore: true });
    expect(service.snapshot().directories[0].sessions.map((item) => item.id)).toEqual(['ses_b', 'ses_a']);
    service.close();
  });

  it('excludes SmartFetch secondary sessions and clears existing summaries', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    const temporary = { ...session('ses_temporary', 11), title: 'smartfetch-secondary' };

    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_visible', 12), temporary],
      cursor: null,
      hasMore: false,
    });
    expect(service.snapshot().directories[0].sessions.map((item) => item.id)).toEqual(['ses_visible']);

    service.upsert(session('ses_existing', 10));
    service.upsert({ ...temporary, id: 'ses_existing' });
    expect(service.snapshot().directories[0].sessions.map((item) => item.id)).toEqual(['ses_visible']);
    service.close();
  });

  it('orders by user activity without changing the OpenCode updated time', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_newer', 20), session('ses_active', 10)],
      cursor: null,
      hasMore: false,
    });

    service.touchActivity('ses_active', 30);

    const sessions = service.snapshot().directories[0].sessions;
    expect(sessions.map((item) => item.id)).toEqual(['ses_active', 'ses_newer']);
    expect(sessions[0].time.updated).toBe(10);
    expect(sessions[0].metadata.openchamber.titleRefresh.activityUpdatedAt).toBe(30);
    service.close();
  });

  it('keeps event summary updates from advancing user activity ordering', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: null, hasMore: false });

    service.upsert(session('ses_a', 20), 20, { preserveActivity: true });

    const stored = service.snapshot().directories[0].sessions[0];
    expect(stored.time.updated).toBe(20);
    expect(stored.metadata.openchamber.titleRefresh.activityUpdatedAt).toBe(10);
    service.close();
  });

  it('reports exact event-summary repeats as unchanged without touching directory recency', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: null, hasMore: false, now: 1000 });

    expect(service.upsertAndReportChange(session('ses_a', 10), 2000, { preserveActivity: true })).toBe(false);
    expect(service.upsert(session('ses_a', 10), 2500, { preserveActivity: true })).toBe(true);
    expect(service.snapshot().directories[0].lastAccessedAt).toBe(1000);

    expect(service.upsertAndReportChange({ ...session('ses_a', 10), title: 'Renamed' }, 3000, { preserveActivity: true })).toBe(true);
    expect(service.snapshot().directories[0]).toMatchObject({
      lastAccessedAt: 3000,
      sessions: [expect.objectContaining({ id: 'ses_a', title: 'Renamed' })],
    });
    service.close();
  });

  it('ignores event summaries that remain outside the bounded root page', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    const sessions = Array.from({ length: 20 }, (_, index) => session(`ses_${index}`, 100 - index));
    service.replaceDirectory({ directory: '/repo', sessions, cursor: 80, hasMore: true, now: 1000 });

    expect(service.upsertAndReportChange(session('ses_old', 1), 2000, { preserveActivity: true })).toBe(false);

    const snapshot = service.snapshot().directories[0];
    expect(snapshot.lastAccessedAt).toBe(1000);
    expect(snapshot.sessions).toHaveLength(20);
    expect(snapshot.sessions.some((item) => item.id === 'ses_old')).toBe(false);
    service.close();
  });

  it('stores the latest session status transition independently from ordering', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)], cursor: null, hasMore: false });

    expect(service.updateStatus('ses_a', 'busy', 20)).toBe(true);
    expect(service.updateStatus('ses_a', 'idle', 10)).toBe(false);

    const stored = service.snapshot().directories[0].sessions[0];
    expect(stored.metadata.openchamber.sessionStatus).toEqual({ type: 'busy', changedAt: 20 });
    expect(stored.metadata.openchamber.titleRefresh.activityUpdatedAt).toBe(10);
    service.close();
  });

  it('persists child-session membership and clears the parent flag when the final child is removed', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_parent', 10)], cursor: null, hasMore: false });

    service.upsert({ ...session('ses_child', 11), parentID: 'ses_parent' });
    expect(service.snapshot().directories[0].sessions[0]).toMatchObject({ id: 'ses_parent', hasChildren: true });

    service.remove('ses_child');
    expect(service.snapshot().directories[0].sessions[0]).not.toHaveProperty('hasChildren');
    service.close();
  });

  it('reports repeated child membership as unchanged', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_parent', 10)], cursor: null, hasMore: false, now: 1000 });
    const child = { ...session('ses_child', 11), parentID: 'ses_parent' };

    expect(service.upsertAndReportChange(child, 2000, { preserveActivity: true })).toBe(true);
    expect(service.upsertAndReportChange(child, 3000, { preserveActivity: true })).toBe(false);
    expect(service.snapshot().directories[0].lastAccessedAt).toBe(2000);
    service.close();
  });

  it('reconciles persisted child membership from an authoritative child list', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_parent', 10)], cursor: null, hasMore: false });

    service.replaceChildSessions('/repo', 'ses_parent', [session('ses_child', 11)]);
    expect(service.snapshot().directories[0].sessions[0]).toMatchObject({ id: 'ses_parent', hasChildren: true });

    service.replaceChildSessions('/repo', 'ses_parent', []);
    expect(service.snapshot().directories[0].sessions[0]).not.toHaveProperty('hasChildren');
    service.close();
  });

  it('tracks incremental writes without advancing the last full reconciliation', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_a', 10)],
      cursor: 8,
      hasMore: true,
      now: 1000,
    });
    service.replaceDirectory({
      directory: '/repo',
      sessions: [session('ses_a', 10), session('ses_b', 11)],
      cursor: 8,
      hasMore: true,
      fullSync: false,
      now: 2000,
    });

    expect(service.snapshot().directories[0]).toMatchObject({
      lastSyncedAt: 2000,
      lastFullSyncedAt: 1000,
    });
    service.close();
  });

  it('rebuilds an incompatible cache schema instead of migrating it', () => {
    const runtimeRef = { value: 'http://runtime-a.test' };
    const service = createService(runtimeRef);
    service.replaceDirectory({ directory: '/repo', sessions: [session('ses_a', 10)] });
    service.close();

    const dbPath = path.join(tempDirectories[tempDirectories.length - 1], 'session-index.sqlite');
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(dbPath);
    db.prepare("UPDATE session_index_meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();

    const rebuilt = createSessionIndexService({
      dbPath,
      getRuntimeConfig: () => ({ apiBaseUrl: runtimeRef.value }),
    });
    expect(rebuilt.snapshot().directories).toEqual([]);
    rebuilt.close();
  });
});
