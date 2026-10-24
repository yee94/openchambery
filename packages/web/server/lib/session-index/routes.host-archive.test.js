import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore } from '../session-metadata/session-metadata-store.js';
import { createSessionArchiveService } from '../session-metadata/session-archive.js';
import { createSessionIndexService } from './service.js';
import { registerSessionIndexRoutes } from './routes.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-index-host-'));
  tempDirs.push(dir);
  return dir;
};

const registry = () => {
  const routes = new Map();
  return {
    app: {
      get: (pathValue, handler) => routes.set(`GET ${pathValue}`, handler),
      put: (pathValue, handler) => routes.set(`PUT ${pathValue}`, handler),
      post: (pathValue, handler) => routes.set(`POST ${pathValue}`, handler),
      delete: (pathValue, handler) => routes.set(`DELETE ${pathValue}`, handler),
    },
    route: (method, pathValue) => routes.get(`${method} ${pathValue}`),
  };
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});

describe('session-index routes + Host archive (production path)', () => {
  it('snapshot/lookup filter Host-archived rows and pins; 503 when metadata unavailable', async () => {
    const dataDir = makeDir();
    const store = createSessionMetadataStore({ dataDir });
    const index = createSessionIndexService({
      dbPath: path.join(dataDir, 'index.sqlite'),
      getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime-test' }),
    });
    index.replaceDirectory({
      directory: '/repo',
      sessions: [
        { id: 'ses_live', title: 'Live', directory: '/repo', time: { created: 1, updated: 10 } },
        { id: 'ses_arch', title: 'Arch', directory: '/repo', time: { created: 1, updated: 9 } },
      ],
      cursor: null,
      hasMore: false,
    });
    index.setPinned('ses_arch', 50);
    index.setPinned('ses_live', 51);

    await store.setSessionMetadata('ses_arch', {
      openchamber: { archive: { archivedAt: 99 } },
    }, { allowArchive: true });

    const { app, route } = registry();
    registerSessionIndexRoutes(app, {
      sessionIndexService: index,
      getCommittedHostMetadata: () => store.getAll(),
    });

    const snapRes = response();
    await route('GET', '/api/openchamber/session-index')({}, snapRes);
    expect(snapRes.statusCode).toBe(200);
    expect(snapRes.body.directories[0].sessions.map((s) => s.id)).toEqual(['ses_live']);
    expect(snapRes.body.pinnedSessionIds).toEqual(['ses_live']);

    const lookupArch = response();
    await route('GET', '/api/openchamber/session-index/session/:sessionId')(
      { params: { sessionId: 'ses_arch' } },
      lookupArch,
    );
    expect(lookupArch.statusCode).toBe(404);

    const lookupLive = response();
    await route('GET', '/api/openchamber/session-index/session/:sessionId')(
      { params: { sessionId: 'ses_live' } },
      lookupLive,
    );
    expect(lookupLive.statusCode).toBe(200);
    expect(lookupLive.body.session.id).toBe('ses_live');

    // Metadata unavailable → 503 retryable (production gate).
    const { app: app2, route: route2 } = registry();
    registerSessionIndexRoutes(app2, {
      sessionIndexService: index,
      getCommittedHostMetadata: async () => {
        throw new Error('session metadata is unavailable: EACCES');
      },
    });
    const failRes = response();
    await route2('GET', '/api/openchamber/session-index')({}, failRes);
    expect(failRes.statusCode).toBe(503);
    expect(failRes.body).toMatchObject({ retryable: true, code: 'session_metadata_unavailable' });

    index.close();
  });

  it('index write failure after archive schedules repair; rebuild re-projects from store', async () => {
    const dataDir = makeDir();
    const store = createSessionMetadataStore({ dataDir });
    const timers = [];
    const setTimer = (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    };
    const clearTimer = (handle) => { if (handle) handle.cleared = true; };

    let upsertFails = true;
    const upserts = [];
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async ({ sessionID }) => ({
        id: sessionID,
        directory: '/repo',
        title: 'S',
        time: { created: 1, updated: 2 },
      }),
      sessionIndexService: {
        upsertAndReportChange: (session) => {
          upserts.push(session);
          if (upsertFails) throw new Error('sqlite locked');
          return true;
        },
      },
      setTimer,
      clearTimer,
      now: () => 1_000,
    });

    const result = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 77 });
    expect(result.index).toMatchObject({ ok: false, retryable: true });
    await expect(store.get('ses_1')).resolves.toMatchObject({
      openchamber: { archive: { archivedAt: 77 } },
    });
    expect(archive.getIndexRepairStatus('ses_1')).toMatchObject({ pending: true, retryable: true });
    expect(timers).toHaveLength(1);
    expect(timers[0].cleared).toBe(false);

    // Repair run: re-project from committed store (not stale blob).
    upsertFails = false;
    await timers[0].fn();
    expect(upserts.at(-1)?.time?.archived).toBe(77);
    expect(archive.getIndexRepairStatus('ses_1')).toMatchObject({ ok: true, pending: false });

    // stop() clears any remaining scheduled timers (none left after success).
    archive.stop();
    expect(archive.getIndexRepairStatus('ses_1').pending).toBe(false);
  });

  it('restart: fresh store+index routes hide Host-archived without pending repair state', async () => {
    const dataDir = makeDir();
    const store1 = createSessionMetadataStore({ dataDir });
    await store1.setSessionMetadata('ses_x', {
      openchamber: { archive: { archivedAt: 5 } },
    }, { allowArchive: true });

    // Simulate crash after metadata commit: index still has the row.
    const index = createSessionIndexService({
      dbPath: path.join(dataDir, 'index.sqlite'),
      getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime-restart' }),
    });
    index.replaceDirectory({
      directory: '/repo',
      sessions: [
        { id: 'ses_x', title: 'X', directory: '/repo', time: { created: 1, updated: 2 } },
        { id: 'ses_y', title: 'Y', directory: '/repo', time: { created: 1, updated: 3 } },
      ],
      cursor: null,
      hasMore: false,
    });

    // Process restart: new store loads committed archive.
    const store2 = createSessionMetadataStore({ dataDir });
    const { app, route } = registry();
    registerSessionIndexRoutes(app, {
      sessionIndexService: index,
      getCommittedHostMetadata: () => store2.getAll(),
    });
    const res = response();
    await route('GET', '/api/openchamber/session-index')({}, res);
    expect(res.body.directories[0].sessions.map((s) => s.id)).toEqual(['ses_y']);
    index.close();
  });

  it('list snapshots drop unread Host metadata; lookup keeps the full projection', async () => {
    const dataDir = makeDir();
    const store = createSessionMetadataStore({ dataDir });
    const index = createSessionIndexService({
      dbPath: path.join(dataDir, 'index.sqlite'),
      getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime-test' }),
    });
    index.replaceDirectory({
      directory: '/repo',
      sessions: [{ id: 'ses_a', title: 'A', directory: '/repo', time: { created: 1, updated: 10 } }],
      cursor: null,
      hasMore: false,
    });
    await store.setSessionMetadata('ses_a', {
      openchamber: {
        titleAuthority: { sessionID: 'ses_a', title: 'A', revision: 'rev-1', source: 'manual' },
        scheduledTaskSkill: { hostOrigin: 'http://127.0.0.1:1' },
        scheduledTask: { taskID: 'task-1' },
        goal: { objective: 'ship' },
        titleRefresh: {
          activityUpdatedAt: 20,
          isGenerating: true,
          lastError: 'boom',
          failedAt: 30,
          lastAutoTitle: 'Auto',
          requestedAt: 40,
          forMessageID: 'msg_1',
          generatedAt: 50,
          forkFirstSendSessionID: 'ses_parent',
        },
      },
    });

    const { app, route } = registry();
    registerSessionIndexRoutes(app, {
      sessionIndexService: index,
      getCommittedHostMetadata: () => store.getAll(),
    });

    const snapRes = response();
    await route('GET', '/api/openchamber/session-index')({}, snapRes);
    const listed = snapRes.body.directories[0].sessions[0].metadata.openchamber;
    expect(listed.titleAuthority).toBeUndefined();
    expect(listed.scheduledTaskSkill).toBeUndefined();
    expect(listed.scheduledTask).toEqual({ taskID: 'task-1' });
    expect(listed.goal).toEqual({ objective: 'ship' });
    expect(listed.titleRefresh).toEqual({
      activityUpdatedAt: 20,
      isGenerating: true,
      lastError: 'boom',
      failedAt: 30,
      lastAutoTitle: 'Auto',
      requestedAt: 40,
    });
    expect(listed.sessionStatus).toMatchObject({ type: 'idle' });

    const lookupRes = response();
    await route('GET', '/api/openchamber/session-index/session/:sessionId')(
      { params: { sessionId: 'ses_a' } },
      lookupRes,
    );
    expect(lookupRes.body.session.metadata.openchamber.titleAuthority).toMatchObject({ revision: 'rev-1' });
    expect(lookupRes.body.session.metadata.openchamber.titleRefresh.forMessageID).toBe('msg_1');
    index.close();
  });

  it('POST /sync applies the same Host archive gate as GET', async () => {
    const dataDir = makeDir();
    const store = createSessionMetadataStore({ dataDir });
    const index = createSessionIndexService({
      dbPath: path.join(dataDir, 'index.sqlite'),
      getRuntimeConfig: () => ({ apiBaseUrl: 'http://runtime-test' }),
    });
    index.replaceDirectory({
      directory: '/repo',
      sessions: [
        { id: 'ses_live', title: 'Live', directory: '/repo', time: { created: 1, updated: 10 } },
        { id: 'ses_arch', title: 'Arch', directory: '/repo', time: { created: 1, updated: 9 } },
      ],
      cursor: null,
      hasMore: false,
    });
    index.setPinned('ses_arch', 50);
    await store.setSessionMetadata('ses_arch', {
      openchamber: { archive: { archivedAt: 99 } },
    }, { allowArchive: true });
    const enqueue = vi.fn(() => ({ revision: 3, sync: { active: true }, ...index.snapshot() }));
    const syncRuntime = { enqueue, snapshot: () => ({ revision: 3, ...index.snapshot() }) };

    const { app, route } = registry();
    registerSessionIndexRoutes(app, {
      sessionIndexService: index,
      sessionIndexSyncRuntime: syncRuntime,
      getCommittedHostMetadata: () => store.getAll(),
    });
    const res = response();
    await route('POST', '/api/openchamber/session-index/sync')({ body: { directories: ['/repo'] } }, res);
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(['/repo']);
    expect(res.body).toMatchObject({ revision: 3, sync: { active: true } });
    expect(res.body.directories[0].sessions.map((s) => s.id)).toEqual(['ses_live']);
    expect(res.body.pinnedSessionIds).toEqual([]);

    const { app: app2, route: route2 } = registry();
    registerSessionIndexRoutes(app2, {
      sessionIndexService: index,
      sessionIndexSyncRuntime: syncRuntime,
      getCommittedHostMetadata: async () => {
        throw new Error('session metadata is unavailable: EACCES');
      },
    });
    const failRes = response();
    await route2('POST', '/api/openchamber/session-index/sync')({ body: { directories: ['/repo'] } }, failRes);
    expect(failRes.statusCode).toBe(503);
    expect(failRes.body).toMatchObject({ retryable: true, code: 'session_metadata_unavailable' });
    index.close();
  });
});
