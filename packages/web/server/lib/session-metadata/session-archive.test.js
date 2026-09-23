import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore } from './session-metadata-store.js';
import {
  createSessionArchiveService,
} from './session-archive.js';
import {
  projectSessionWithHostMetadata,
  projectSessionWithStoredMap,
  readHostArchivedAt,
} from './session-projection.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-archive-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const upstreamSession = (overrides = {}) => ({
  id: 'ses_1',
  title: 'Alpha',
  directory: '/repo',
  time: { created: 100, updated: 200 },
  ...overrides,
});

describe('session archive host loop', () => {
  it('archives via Host store, projects list/get, survives store reopen, then unarchives', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    const upstream = {
      ses_1: upstreamSession({
        // Historical upstream archive stamp must yield to Host authority.
        time: { created: 100, updated: 200, archived: 50 },
      }),
    };

    const indexUpserts = [];
    const broadcasts = [];
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async ({ sessionID }) => upstream[sessionID] ?? null,
      sessionIndexService: {
        upsertAndReportChange: (session) => {
          indexUpserts.push(session);
          return true;
        },
      },
      broadcastSessionEvent: (event) => {
        broadcasts.push(event);
      },
      now: () => 1_700_000_000_000,
    });

    const archived = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 1_700_000_000_123 });
    expect(archived.session.time.archived).toBe(1_700_000_000_123);
    expect(archived.session.time.created).toBe(100);
    expect(archived.session.time.updated).toBe(200);
    expect(archived.session.metadata.openchamber.archive.archivedAt).toBe(1_700_000_000_123);
    expect(indexUpserts.at(-1)?.time?.archived).toBe(1_700_000_000_123);
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', time: { archived: 1_700_000_000_123 } } },
    });

    const storedMap = await store.getAll();
    const listProjected = projectSessionWithStoredMap(upstream.ses_1, storedMap);
    const getProjected = projectSessionWithHostMetadata(
      upstream.ses_1,
      await store.get('ses_1'),
    );
    expect(listProjected.time.archived).toBe(1_700_000_000_123);
    expect(getProjected.time.archived).toBe(1_700_000_000_123);

    // Fresh process: rebuild store from disk and still project Host archive.
    const reopened = createSessionMetadataStore({ dataDir });
    await expect(reopened.get('ses_1')).resolves.toEqual({
      openchamber: { archive: { archivedAt: 1_700_000_000_123 } },
    });
    expect(
      projectSessionWithHostMetadata(upstream.ses_1, await reopened.get('ses_1')).time.archived,
    ).toBe(1_700_000_000_123);

    const unarchived = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 0 });
    // Explicit 0 clears archive even when upstream still carries historical time.archived.
    expect(unarchived.session.time.archived).toBeUndefined();
    expect(readHostArchivedAt(unarchived.metadata)).toBe(0);
    expect(indexUpserts.at(-1)?.time?.archived).toBeUndefined();

    const afterCancel = projectSessionWithHostMetadata(
      upstream.ses_1,
      await store.get('ses_1'),
    );
    expect(afterCancel.time.archived).toBeUndefined();
  });

  it('does not report post-commit index/broadcast failure as write failure', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async () => upstreamSession(),
      sessionIndexService: {
        upsertAndReportChange: () => {
          throw new Error('index down');
        },
      },
      broadcastSessionEvent: () => {
        throw new Error('broadcast down');
      },
    });

    await expect(archive.setArchive({ sessionID: 'ses_1', archivedAt: 99 })).resolves.toMatchObject({
      session: { id: 'ses_1', time: { archived: 99 } },
    });
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { archive: { archivedAt: 99 } },
    });
  });

  it('refuses archive when upstream session is missing', async () => {
    const archive = createSessionArchiveService({
      sessionMetadataStore: createSessionMetadataStore({ dataDir: makeDataDir() }),
      fetchUpstreamSession: async () => null,
    });
    await expect(archive.setArchive({ sessionID: 'ses_missing', archivedAt: 1 }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('refuses directory mismatch before persisting', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async () => upstreamSession({ directory: '/repo-a' }),
    });
    await expect(archive.setArchive({
      sessionID: 'ses_1',
      archivedAt: 1,
      directory: '/repo-b',
    })).rejects.toMatchObject({ code: 'directory_mismatch', status: 403 });
    await expect(store.get('ses_1')).resolves.toEqual({});
  });

  it('prefers location.directory and rejects id mismatch', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async () => ({
        id: 'ses_1',
        location: { directory: '/from-location' },
        directory: '/legacy',
        time: { created: 1, updated: 2 },
      }),
    });
    const result = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 5 });
    expect(result.session.directory).toBe('/from-location');

    const bad = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async () => ({ id: 'ses_other', directory: '/repo', time: {} }),
    });
    await expect(bad.setArchive({ sessionID: 'ses_1', archivedAt: 1 }))
      .rejects.toMatchObject({ code: 'id_mismatch' });
  });

  it('reports retryable index failure after metadata commit and schedules repair', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timers = [];
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async () => upstreamSession(),
      sessionIndexService: {
        upsertAndReportChange: () => {
          throw new Error('sqlite locked');
        },
      },
      setTimer: (fn, ms) => {
        const h = { fn, ms };
        timers.push(h);
        return h;
      },
      clearTimer: () => {},
    });
    const result = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 7 });
    expect(result.session.time.archived).toBe(7);
    expect(result.index).toMatchObject({ ok: false, retryable: true });
    await expect(store.get('ses_1')).resolves.toMatchObject({
      openchamber: { archive: { archivedAt: 7 } },
    });
    expect(archive.getIndexRepairStatus('ses_1')).toMatchObject({ pending: true, retryable: true });
    expect(timers.length).toBeGreaterThan(0);
    archive.stop();
  });

  it('stale repair after hung GET cannot remove index after unarchive', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    const indexWrites = [];
    let hangNextFetch = false;
    let releaseFetch;
    const hungFetch = new Promise((resolve) => { releaseFetch = resolve; });
    const removes = [];

    const timers = [];
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async ({ sessionID }) => {
        if (hangNextFetch) {
          hangNextFetch = false;
          await hungFetch;
        }
        return {
          id: sessionID,
          directory: '/repo',
          title: 'S',
          time: { created: 1, updated: 2 },
        };
      },
      sessionIndexService: {
        upsertAndReportChange: (session) => {
          indexWrites.push({
            id: session.id,
            archived: session.time?.archived,
          });
          // First archive index apply fails → schedules repair.
          if (indexWrites.length === 1) throw new Error('sqlite locked');
          return true;
        },
        remove: (id) => {
          removes.push(id);
          return true;
        },
      },
      setTimer: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimer: () => {},
      now: () => 1_000,
    });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Archive: metadata commits, index fails, repair scheduled.
    const archived = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 99 });
    expect(archived.index.ok).toBe(false);
    expect(timers).toHaveLength(1);

    // Fire repair timer → GET hangs.
    hangNextFetch = true;
    const repairPromise = timers[0]();
    await Promise.resolve();
    await Promise.resolve();

    // Unarchive completes while repair GET is still hanging.
    const unarchived = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 0 });
    expect(unarchived.session.time.archived).toBeUndefined();
    expect(readHostArchivedAt(await store.get('ses_1'))).toBe(0);
    expect(indexWrites.at(-1)?.archived).toBeUndefined();
    const writesAfterUnarchive = indexWrites.length;

    // Old hung GET returns — must not remove active session or re-apply archive.
    releaseFetch();
    await repairPromise;

    expect(readHostArchivedAt(await store.get('ses_1'))).toBe(0);
    expect(indexWrites.length).toBe(writesAfterUnarchive);
    expect(indexWrites.at(-1)?.archived).toBeUndefined();
    expect(removes).toEqual([]);
    archive.stop();
  });

  it('stop supersedes in-flight repair so late GET does not write', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    let releaseFetch;
    const hung = new Promise((resolve) => { releaseFetch = resolve; });
    let hangRepairFetch = false;
    const writes = [];
    const timers = [];
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async ({ sessionID }) => {
        if (hangRepairFetch) {
          hangRepairFetch = false;
          await hung;
        }
        return { id: sessionID, directory: '/repo', time: { created: 1, updated: 2 } };
      },
      sessionIndexService: {
        upsertAndReportChange: (s) => {
          writes.push({ id: s.id, archived: s.time?.archived });
          if (writes.length === 1) throw new Error('fail');
          return true;
        },
      },
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await archive.setArchive({ sessionID: 'ses_stop', archivedAt: 1 });
    hangRepairFetch = true;
    const repair = timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    archive.stop();
    releaseFetch();
    await repair;
    // setArchive failed write only — stop made late repair stale (no second write).
    expect(writes).toEqual([{ id: 'ses_stop', archived: 1 }]);
  });

  it('forgetSession treats missing as success and retries write failures', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_1', { a: 1 });
    const timers = [];
    let failWrite = true;
    const fsPromises = {
      ...fs.promises,
      writeFile: async (...args) => {
        if (failWrite) throw new Error('disk full');
        return fs.promises.writeFile(...args);
      },
    };
    const failingStore = createSessionMetadataStore({ dataDir, fsPromises });
    await failingStore.load();
    const archive = createSessionArchiveService({
      sessionMetadataStore: failingStore,
      fetchUpstreamSession: async () => upstreamSession(),
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => {},
    });
    const failed = await archive.forgetSession('ses_1');
    expect(failed).toMatchObject({ ok: false, retryable: true });
    expect(archive.getCleanupStatus('ses_1')).toMatchObject({ pending: true });
    expect(timers).toHaveLength(1);

    failWrite = false;
    await timers[0]();
    expect(archive.getCleanupStatus('ses_1')).toMatchObject({ ok: true, pending: false });

    // Already gone is success.
    const gone = await archive.forgetSession('ses_missing');
    expect(gone).toMatchObject({ ok: true });
    archive.stop();
  });
});
