import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-metadata-'));
  tempDirs.push(dir);
  return dir;
};

const readFile = (dataDir) => fs.readFileSync(path.join(dataDir, 'sessions-metadata.json'), 'utf8');

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('mergeMetadataPatch', () => {
  it('merges nested objects key by key instead of replacing them', () => {
    const current = { openchamber: { goal: { id: 'g1', status: 'active' }, assist: { recap: 'r' } } };
    const merged = mergeMetadataPatch(current, { openchamber: { goal: { status: 'complete' } } });

    expect(merged).toEqual({
      openchamber: { goal: { id: 'g1', status: 'complete' }, assist: { recap: 'r' } },
    });
    // The input is untouched: callers keep whatever they already held.
    expect(current.openchamber.goal.status).toBe('active');
  });

  it('deletes a key when its patch value is null', () => {
    expect(mergeMetadataPatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ openchamber: { goal: {}, assist: {} } }, { openchamber: { assist: null } }))
      .toEqual({ openchamber: { goal: {} } });
  });

  it('replaces arrays and scalars rather than merging into them', () => {
    expect(mergeMetadataPatch({ pins: ['a', 'b'] }, { pins: ['c'] })).toEqual({ pins: ['c'] });
    expect(mergeMetadataPatch({ a: { nested: true } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });

  it('treats a missing or non-object base as empty', () => {
    expect(mergeMetadataPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch('nope', { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ a: 1 }, 'nope')).toEqual({ a: 1 });
  });
});

describe('createSessionMetadataStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await expect(store.getAll()).resolves.toEqual({});
    await expect(store.get('ses_1')).resolves.toEqual({});
  });

  it('stores a patch, persists it, and reads it back in a fresh store', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });
    expect(merged).toEqual({ openchamber: { goal: { id: 'g1' } } });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { openchamber: { goal: { id: 'g1' } } } });

    const reopened = createSessionMetadataStore({ dataDir });
    await expect(reopened.get('ses_1')).resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
  });

  it('keeps a neighbouring namespace when another feature writes', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'done' } } });
    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } });

    expect(merged).toEqual({ openchamber: { assist: { recap: 'done' }, goal: { status: 'active' } } });
  });

  it('deletes a key with a null patch value and drops a session that empties out', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });

    await expect(store.setSessionMetadata('ses_1', { openchamber: null })).resolves.toEqual({});
    await expect(store.getAll()).resolves.toEqual({});
    expect(JSON.parse(readFile(dataDir))).toEqual({});
  });

  it('scopes metadata per session', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { a: 1 });
    await store.setSessionMetadata('ses_2', { b: 2 });

    await expect(store.getAll()).resolves.toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('rejects a blank session id and a non-object patch', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await expect(store.setSessionMetadata('  ', { a: 1 })).rejects.toThrow(/session id is required/);
    await expect(store.setSessionMetadata('ses_1', 'nope')).rejects.toThrow(/must be an object/);
    await expect(store.setSessionMetadata('ses_1', ['a'])).rejects.toThrow(/must be an object/);
  });

  it('writes atomically: the visible file is never a partial payload', async () => {
    const dataDir = makeDataDir();
    const seen = [];
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        // The visible file must still be the previous one at this point.
        seen.push(fs.existsSync(path.join(dataDir, 'sessions-metadata.json')) ? readFile(dataDir) : null);
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });

    await store.setSessionMetadata('ses_1', { a: 1 });
    await store.setSessionMetadata('ses_2', { b: 2 });

    expect(seen).toEqual([null, JSON.stringify({ ses_1: { a: 1 } })]);
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('refuses corrupt JSON as empty success and does not overwrite the file', async () => {
    const dataDir = makeDataDir();
    const corruptPath = path.join(dataDir, 'sessions-metadata.json');
    fs.writeFileSync(corruptPath, '{ not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createSessionMetadataStore({ dataDir });
    await expect(store.getAll()).rejects.toThrow(/unavailable|corrupt/i);
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow(/unavailable|corrupt/i);
    expect(fs.readFileSync(corruptPath, 'utf8')).toBe('{ not json');
    expect(store.isLoaded()).toBe(false);
    expect(store.getSnapshotSync()).toBeNull();
  });

  it('drops entries that are not metadata objects', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(
      path.join(dataDir, 'sessions-metadata.json'),
      JSON.stringify({ ses_ok: { a: 1 }, ses_list: ['a'], ses_text: 'nope', ses_null: null }),
      'utf8',
    );
    const store = createSessionMetadataStore({ dataDir });
    await expect(store.getAll()).resolves.toEqual({ ses_ok: { a: 1 } });
  });

  it('refuses to write when the file could not be read, so unknown state is never overwritten', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-metadata.json'), '{}', 'utf8');
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsPromises = {
      ...fs.promises,
      readFile: async () => { throw unreadable; },
      writeFile: async () => { throw new Error('must not write'); },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow(/unavailable/);
    expect(readFile(dataDir)).toBe('{}');
  });

  it('does not publish uncommitted drafts while persist is blocked (set)', async () => {
    const dataDir = makeDataDir();
    let releaseWrite;
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        await writeGate;
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    const pending = store.setSessionMetadata('ses_1', { a: 1 });
    // Concurrent readers must still see committed empty — not the in-flight draft.
    await expect(store.get('ses_1')).resolves.toEqual({});
    expect(store.getSnapshotSync()).toEqual({});
    releaseWrite();
    await expect(pending).resolves.toEqual({ a: 1 });
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
  });

  it('does not publish uncommitted deletes while persist is blocked (remove)', async () => {
    const dataDir = makeDataDir();
    const storeWarm = createSessionMetadataStore({ dataDir });
    await storeWarm.setSessionMetadata('ses_1', { a: 1 });

    let releaseWrite = null;
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        if (releaseWrite) await new Promise((resolve) => { releaseWrite = resolve; });
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await store.load();
    // Arm the gate only for the remove persist.
    releaseWrite = () => {};
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    fsPromises.writeFile = async (target, payload, encoding) => {
      await gate;
      return fs.promises.writeFile(target, payload, encoding);
    };
    const pending = store.removeSession('ses_1');
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
    unlock();
    await expect(pending).resolves.toBe(true);
    await expect(store.get('ses_1')).resolves.toEqual({});
  });

  it('keeps committed entries when persist fails (set never published)', async () => {
    const dataDir = makeDataDir();
    const storeOk = createSessionMetadataStore({ dataDir });
    await storeOk.setSessionMetadata('ses_1', { a: 1 });

    const fsPromises = { ...fs.promises, writeFile: async () => { throw new Error('disk full'); } };
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await expect(store.setSessionMetadata('ses_1', { b: 2 })).rejects.toThrow('disk full');
    await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
  });

  it('forgets a session on request', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_1', { a: 1 });

    await expect(store.removeSession('ses_1')).resolves.toBe(true);
    await expect(store.removeSession('ses_1')).resolves.toBe(false);
    expect(JSON.parse(readFile(dataDir))).toEqual({});
  });

  it('serializes concurrent writes so neighboring keys are not lost', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await Promise.all([
      store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } }),
      store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'a' } } }),
    ]);
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { goal: { id: 'g1' }, assist: { recap: 'a' } },
    });
  });

  it('protects Host archive from generic metadata null ancestor deletes', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { openchamber: { archive: { archivedAt: 9 } } }, { allowArchive: true });
    await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { archive: { archivedAt: 9 }, goal: { id: 'g1' } },
    });
    await store.setSessionMetadata('ses_1', { openchamber: null });
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { archive: { archivedAt: 9 } },
    });
    await store.setSessionMetadata('ses_1', { openchamber: { archive: { archivedAt: 1 } } });
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { archive: { archivedAt: 9 } },
    });
  });

  it('does not treat a failed load as empty success on get/getAll', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-metadata.json'), '{}', 'utf8');
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsPromises = {
      ...fs.promises,
      readFile: async () => { throw unreadable; },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await expect(store.get('ses_1')).rejects.toThrow(/unavailable|could not be read|EACCES/i);
    await expect(store.getAll()).rejects.toThrow(/unavailable|could not be read|EACCES/i);
    expect(store.getSnapshotSync()).toBeNull();
  });

  it('mutateSessionMetadata commits only when decide returns ok with a patch', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', {
      openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 2 }, assist: { recap: 'keep' } },
    });

    const rejected = await store.mutateSessionMetadata('ses_1', (current) => {
      const gen = current?.openchamber?.goal?.executionGeneration;
      if (gen !== 2) return { ok: false, reason: 'generation_mismatch' };
      return {
        ok: false,
        reason: 'status_not_active',
      };
    });
    expect(rejected).toEqual({
      committed: false,
      reason: 'status_not_active',
      metadata: {
        openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 2 }, assist: { recap: 'keep' } },
      },
    });
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 2 }, assist: { recap: 'keep' } },
    });

    const accepted = await store.mutateSessionMetadata('ses_1', (current) => {
      if (current?.openchamber?.goal?.executionGeneration !== 2) {
        return { ok: false, reason: 'generation_mismatch' };
      }
      return {
        ok: true,
        patch: { openchamber: { goal: { status: 'paused', executionGeneration: 3 } } },
      };
    });
    expect(accepted.committed).toBe(true);
    expect(accepted.metadata.openchamber.goal).toEqual({
      id: 'g1',
      status: 'paused',
      executionGeneration: 3,
    });
    expect(accepted.metadata.openchamber.assist).toEqual({ recap: 'keep' });
  });

  it('mutateSessionMetadata does not publish drafts while persist is blocked', async () => {
    const dataDir = makeDataDir();
    await createSessionMetadataStore({ dataDir }).setSessionMetadata('ses_1', {
      openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 1 } },
    });

    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        await gate;
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await store.load();

    const pending = store.mutateSessionMetadata('ses_1', () => ({
      ok: true,
      patch: { openchamber: { goal: { status: 'paused', executionGeneration: 2 } } },
    }));
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 1 } },
    });
    expect(store.getSnapshotSync()?.ses_1?.openchamber?.goal?.status).toBe('active');
    unlock();
    await expect(pending).resolves.toMatchObject({
      committed: true,
      metadata: { openchamber: { goal: { status: 'paused', executionGeneration: 2 } } },
    });
  });

  it('mutateSessionMetadata preserves Host archive and serializes with setSessionMetadata', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { openchamber: { archive: { archivedAt: 42 } } }, { allowArchive: true });

    const [mutated] = await Promise.all([
      store.mutateSessionMetadata('ses_1', () => ({
        ok: true,
        patch: { openchamber: { goal: { id: 'g1', status: 'active', executionGeneration: 0 } } },
      })),
      store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'a' } } }),
    ]);
    expect(mutated.committed).toBe(true);
    await expect(store.get('ses_1')).resolves.toEqual({
      openchamber: {
        archive: { archivedAt: 42 },
        goal: { id: 'g1', status: 'active', executionGeneration: 0 },
        assist: { recap: 'a' },
      },
    });
  });
});
