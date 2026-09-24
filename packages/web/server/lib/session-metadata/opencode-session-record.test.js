import { describe, expect, it, vi } from 'vitest';

import { createSessionArchiveService } from './session-archive.js';
import { createSessionMetadataStore } from './session-metadata-store.js';
import {
  createHttpSessionRecordClient,
  mergeOwnedMetadata,
  migrateLoadedSideStore,
  readSessionRecordViaClient,
  retainOpenCodeSessions,
  writeSessionRecordViaClient,
} from './opencode-session-record.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const makeDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-record-'));

describe('OpenCode session record ownership', () => {
  it('keeps title and archive on the OpenCode record across archive and restore', async () => {
    const dataDir = makeDataDir();
    const records = new Map([
      ['ses_1', {
        id: 'ses_1',
        title: 'Keep me',
        metadata: { openchamber: { goal: { status: 'active' }, assistant: { assistantID: 'ast_1' } } },
        time: { created: 1, updated: 2 },
      }],
    ]);
    const writes = [];
    const store = createSessionMetadataStore({
      dataDir,
      recordReader: async (sessionID) => records.get(sessionID) ?? null,
      recordWriter: async (sessionID, metadata) => {
        const current = records.get(sessionID);
        if (!current) {
          const error = new Error('missing');
          error.status = 404;
          throw error;
        }
        writes.push({ sessionID, metadata, title: current.title });
        records.set(sessionID, { ...current, metadata });
      },
    });
    const archive = createSessionArchiveService({
      sessionMetadataStore: store,
      fetchUpstreamSession: async ({ sessionID }) => records.get(sessionID) ?? null,
    });

    const archived = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 50, directory: '/repo' });
    expect(archived.session.title).toBe('Keep me');
    expect(archived.session.time.archived).toBe(50);
    expect(records.get('ses_1').title).toBe('Keep me');
    expect(records.get('ses_1').metadata.openchamber.archive.archivedAt).toBe(50);
    expect(records.get('ses_1').metadata.openchamber.goal.status).toBe('active');
    expect(records.get('ses_1').metadata.openchamber.assistant.assistantID).toBe('ast_1');
    expect(writes.at(-1).metadata.openchamber.assistant.assistantID).toBe('ast_1');

    const restored = await archive.setArchive({ sessionID: 'ses_1', archivedAt: 0 });
    expect(restored.session.title).toBe('Keep me');
    expect(restored.session.time.archived).toBeUndefined();
    expect(records.get('ses_1').title).toBe('Keep me');
    expect(records.get('ses_1').metadata.openchamber.archive.archivedAt).toBe(0);
    expect(records.get('ses_1').metadata.openchamber.goal.status).toBe('active');

    const restarted = createSessionMetadataStore({
      dataDir: makeDataDir(),
      recordReader: async (sessionID) => records.get(sessionID) ?? null,
      recordWriter: async () => undefined,
    });
    await expect(restarted.get('ses_1')).resolves.toMatchObject({
      openchamber: {
        archive: { archivedAt: 0 },
        goal: { status: 'active' },
        assistant: { assistantID: 'ast_1' },
      },
    });
    const visible = retainOpenCodeSessions([records.get('ses_1')], {});
    expect(visible).toHaveLength(1);
    expect(visible[0].title).toBe('Keep me');
    expect(visible[0].time.archived).toBeUndefined();
  });

  it('does not drop an OpenCode session when the side store has no row', () => {
    const visible = retainOpenCodeSessions([
      {
        id: 'ses_1',
        title: 'Still here',
        metadata: { openchamber: { archive: { archivedAt: 9 } } },
        time: { created: 1, updated: 2 },
      },
      { id: 'ses_2', title: 'Also here', time: { created: 1, updated: 2 } },
    ], {});

    expect(visible.map((session) => session.id)).toEqual(['ses_1', 'ses_2']);
    expect(visible[0].title).toBe('Still here');
    expect(visible[0].time.archived).toBe(9);
    expect(visible[1].title).toBe('Also here');
  });

  it('does not treat an unread side store as an empty catalog', () => {
    expect(() => retainOpenCodeSessions([{ id: 'ses_1', title: 'Stay' }], null)).toThrow(/unavailable/);
    expect(() => retainOpenCodeSessions(null, {})).toThrow(/unavailable/);
  });

  it('does not treat a failed side-store load as an authoritative empty migration', async () => {
    const writes = [];
    const records = {
      ses_1: { id: 'ses_1', title: 'Stay', metadata: { openchamber: { goal: { id: 'g1' } } } },
    };
    const result = await migrateLoadedSideStore({
      loadResult: { ok: false, entries: {} },
      readSession: async (id) => records[id] ?? null,
      writeMetadata: async (id, metadata) => {
        writes.push(id);
        records[id] = { ...records[id], metadata };
      },
    });

    expect(result.status).toBe('unavailable');
    expect(writes).toEqual([]);
    expect(records.ses_1.title).toBe('Stay');
    expect(records.ses_1.metadata.openchamber.goal.id).toBe('g1');
  });

  it('keeps other sessions when one migration write fails', async () => {
    const records = {
      ses_ok: { id: 'ses_ok', title: 'Ok', metadata: {} },
      ses_bad: { id: 'ses_bad', title: 'Bad', metadata: { openchamber: { llm: { purpose: 'keep' } } } },
      ses_only_opencode: { id: 'ses_only_opencode', title: 'Stay', metadata: { fromOpenCode: true } },
    };
    const side = {
      ses_ok: { openchamber: { goal: { id: 'g1' } } },
      ses_bad: { openchamber: { assistant: { assistantID: 'ast_1' } } },
    };

    const result = await migrateLoadedSideStore({
      loadResult: { ok: true, entries: side },
      readSession: async (id) => records[id] ?? null,
      writeMetadata: async (id, metadata) => {
        if (id === 'ses_bad') throw new Error('write failed');
        records[id] = { ...records[id], metadata };
      },
    });

    expect(result.status).toBe('partial');
    expect(result.migrated).toEqual(['ses_ok']);
    expect(result.failed).toEqual([{ id: 'ses_bad', error: 'write failed' }]);
    expect(records.ses_ok.metadata.openchamber.goal.id).toBe('g1');
    expect(records.ses_ok.title).toBe('Ok');
    expect(records.ses_bad.title).toBe('Bad');
    expect(records.ses_bad.metadata.openchamber.llm.purpose).toBe('keep');
    expect(records.ses_bad.metadata.openchamber.assistant).toBeUndefined();
    expect(records.ses_only_opencode).toEqual({
      id: 'ses_only_opencode',
      title: 'Stay',
      metadata: { fromOpenCode: true },
    });
    expect(side.ses_bad.openchamber.assistant.assistantID).toBe('ast_1');
  });

  it('fills side-store gaps without letting an empty side row wipe OpenCode fields', () => {
    expect(mergeOwnedMetadata(
      { openchamber: { goal: { status: 'paused' } }, fromOpenCode: true },
      { openchamber: { goal: { id: 'g1' }, archive: { archivedAt: 4 } } },
    )).toEqual({
      fromOpenCode: true,
      openchamber: { goal: { id: 'g1', status: 'paused' }, archive: { archivedAt: 4 } },
    });
    expect(mergeOwnedMetadata({ keep: true }, {})).toEqual({ keep: true });
    expect(mergeOwnedMetadata({ keep: true }, null)).toEqual({ keep: true });
  });

  it('throws when the installed client has no session.update instead of writing nothing', async () => {
    await expect(writeSessionRecordViaClient({ session: {} }, {
      sessionID: 'ses_1',
      metadata: { openchamber: { archive: { archivedAt: 1 } } },
    })).rejects.toThrow(/session\.update is unavailable/);
  });

  it('writes metadata through session.update without sending title', async () => {
    const update = vi.fn(async () => undefined);
    await writeSessionRecordViaClient({ session: { update } }, {
      sessionID: 'ses_1',
      metadata: { openchamber: { archive: { archivedAt: 3 } } },
    });
    expect(update).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      metadata: { openchamber: { archive: { archivedAt: 3 } } },
    }, undefined);
    expect(update.mock.calls[0][0].title).toBeUndefined();
  });

  it('reads a missing session as not-found and a transport failure as failure', async () => {
    const missing = Object.assign(new Error('gone'), { status: 404 });
    await expect(readSessionRecordViaClient({
      session: { get: async () => { throw missing; } },
    }, { sessionID: 'ses_1' })).resolves.toBeNull();

    const down = Object.assign(new Error('down'), { status: 503 });
    await expect(readSessionRecordViaClient({
      session: { get: async () => { throw down; } },
    }, { sessionID: 'ses_1' })).rejects.toThrow(/down/);
  });

  it('patches the session record over HTTP and does not turn a failed read into an empty session', async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === 'PATCH' && String(url).includes('ses_ok')) {
        return { ok: true, status: 204, json: async () => null };
      }
      if (String(url).includes('ses_missing')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (String(url).includes('ses_down')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ses_ok', title: 'Keep', metadata: { fromOpenCode: true } }),
      };
    });
    const client = createHttpSessionRecordClient({
      buildSessionUrl: (sessionID) => `http://opencode.local/api/session/${sessionID}`,
      fetchFn,
    });

    await expect(client.read('ses_ok')).resolves.toMatchObject({ id: 'ses_ok', title: 'Keep' });
    await expect(client.read('ses_missing')).resolves.toBeNull();
    await expect(client.read('ses_down')).rejects.toThrow(/503/);
    await client.write({
      sessionID: 'ses_ok',
      metadata: { openchamber: { archive: { archivedAt: 8 } } },
    });

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch.body).toEqual({ metadata: { openchamber: { archive: { archivedAt: 8 } } } });
    expect(patch.body.title).toBeUndefined();
  });
});
