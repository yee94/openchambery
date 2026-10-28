import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('old completed indexes repair missed updates once, preserve failed results and resume after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-event-repair-'));
  const dbPath = path.join(dir, 'search.sqlite');
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE search_coverage(runtime TEXT PRIMARY KEY, started_at REAL NOT NULL, completed_at REAL, since REAL, verified_at REAL);
    INSERT INTO search_coverage VALUES('host',1,2,0,3);`);
  old.close();
  let service = createContentSearchService({ dbPath });
  const now = 40 * 86400000;
  const record = (id, text) => ({ info: { id, role: 'user', time: { created: now } }, parts: [{ type: 'text', text }] });
  for (const id of ['unchanged', 'missed', 'failed']) service.replaceSession('host', { id, time: { updated: 10 } }, [record(id, 'previous result')], 0);
  let fail = true;
  const listSessions = vi.fn(async () => ({ data: [
    { id: 'missed', time: { updated: now } }, { id: 'failed', time: { updated: now } },
    { id: 'unchanged', time: { updated: 10 } },
  ], cursor: { next: 'older' } }));
  const listMessages = vi.fn(async ({ sessionID }) => {
    if (sessionID === 'failed' && fail) throw new Error('offline');
    return { data: [{ type: 'user', id: sessionID, sessionID, time: { created: now }, text: 'recovered result' }], cursor: {} };
  });
  const create = () => createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => now, listSessions, listMessages });
  let runtime = create();
  try {
    await runtime.sync({ incremental: true });
    expect(service.search('host', 'recovered')).toHaveLength(1);
    expect(service.search('host', 'previous').map((hit) => hit.sessionID).sort()).toEqual(['failed', 'unchanged']);
    expect(runtime.status()).toMatchObject({ phase: 'partial', initializationRequired: false, indexCompletedAt: 2 });
    await runtime.stop(); service.close();
    service = createContentSearchService({ dbPath }); runtime = create(); fail = false;
    await runtime.sync({ incremental: true });
    expect(service.search('host', 'recovered')).toHaveLength(2);
    expect(listMessages.mock.calls.map(([q]) => q.sessionID)).toEqual(['missed', 'failed', 'failed']);
    expect(listSessions).toHaveBeenCalledTimes(2);
    await runtime.stop(); service.close();
    service = createContentSearchService({ dbPath }); runtime = create();
    await runtime.sync({ incremental: true });
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listMessages).toHaveBeenCalledTimes(3);
  } finally { await runtime.stop(); service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
