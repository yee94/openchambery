import { afterEach, expect, test } from 'vitest';
import { createContentSearchService } from './service.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const services = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));

test.each(['needle', '短词'])('limits unique sessions and selects their newest exact match: %s', (query) => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  services.push(service);
  const record = (id, created, text) => ({
    info: { id, role: 'user', time: { created } }, parts: [{ type: 'text', text }],
  });
  service.replaceSession('host', { id: 'busy', directory: '/one' }, [
    ...Array.from({ length: 200 }, (_, i) => record(`m-${i}`, 100 + i, query)),
    record('z-tie', 299, `${query} newest matching message`),
    record('unmatched', 400, 'unrelated'),
  ]);
  service.replaceSession('host', { id: 'other', directory: '/two' }, [record('older', 1, query)]);
  service.replaceSession('foreign', { id: 'busy', directory: '/one' }, [record('foreign', 500, query)]);
  const hits = service.search('host', query, { limit: 2 });
  expect(hits.map((hit) => [hit.sessionID, hit.messageID])).toEqual([['busy', 'z-tie'], ['other', 'older']]);
  expect(hits[0].snippet).toContain('newest matching message');
  expect(service.search('host', query, { limit: 1 })).toEqual(hits.slice(0, 1));
  expect(service.search('host', query, { directory: '/two' })).toEqual(hits.slice(1));
});

test.each([false, true])('upgrades old checkpoints (existing boundary: %s) without inventing coverage and persists initialization across database reopen', (hasBoundary) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-index-'));
  const dbPath = path.join(directory, 'index.sqlite');
  let service;
  try {
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE search_session(runtime TEXT, id TEXT, directory TEXT, title TEXT, updated REAL, PRIMARY KEY(runtime,id));
      INSERT INTO search_session VALUES('host','s','/repo','History',50);`);
    if (hasBoundary) old.exec('ALTER TABLE search_session ADD COLUMN since REAL; UPDATE search_session SET since=0');
    old.close();
    service = createContentSearchService({ dbPath });
    expect(service.updated('host', 's', 0)).toBeUndefined();
    expect(service.coverage('host').indexCompletedAt).toBeNull();
    service.beginInitialization('host', 100);
    service.beginInitialization('host', 101);
    service.close();
    service = createContentSearchService({ dbPath });
    expect(service.coverage('host')).toMatchObject({ indexStartedAt: 100, indexCompletedAt: null });
    service.replaceSession('host', { id: 's', time: { updated: 50 } }, [], 0);
    service.completeInitialization('host', 0, 200);
    service.close();
    service = createContentSearchService({ dbPath });
    expect(service.coverage('host')).toEqual({ indexStartedAt: 100, indexCompletedAt: 200, coveredSince: 0, verifiedAt: 200 });
    expect(service.updated('host', 's', 0)).toBe(50);
    expect(service.coverage('other').indexCompletedAt).toBeNull();
    service.beginInitialization('host', 300);
    expect(service.coverage('host')).toMatchObject({ indexStartedAt: 300, indexCompletedAt: null, verifiedAt: 200 });
  } finally {
    service?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('indexes only admitted text and replaces FTS entries atomically', () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  services.push(service);
  const session = { id: 's', title: 'Title', directory: '/project', time: { updated: 1 } };
  service.replaceSession('host', session, [
    { info: { id: 'u', role: 'user' }, parts: [{ type: 'text', text: 'visible needle' }, { type: 'text', text: 'synthetic-secret', synthetic: true }, { type: 'reasoning', text: 'reasoning-secret' }, { type: 'tool', text: 'tool-secret' }] },
    { info: { id: 'a', role: 'assistant' }, parts: [{ type: 'text', text: 'streaming-secret' }] },
    { info: { id: 'done', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'head-needle' + 'x'.repeat(3000) + 'tail-needle' }] },
  ]);
  expect(service.search('host', 'secret')).toEqual([]);
  expect(service.search('host', 'tail-needle')).toHaveLength(1);
  expect(service.stats('host').textBytes).toBe(2048 + 'visible needle'.length);
  expect(() => service.replaceSession('host', session, [{ info: { id: 'bad', role: 'user' }, parts: null }])).toThrow();
  expect(service.search('host', 'visible')).toHaveLength(1);
  service.replaceSession('host', session, [{ info: { id: 'new', role: 'user' }, parts: [{ type: 'text', text: 'replacement' }] }]);
  expect(service.search('host', 'needle')).toEqual([]);
  expect(service.search('host', 'replacement')).toHaveLength(1);
});

test('finds unvisited messages across projects with authoritative titles and isolates runtimes', () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  services.push(service);
  service.replaceSession('host-a', { id: 's1', title: 'Alpha', directory: '/alpha', time: { updated: 10 } }, [
    { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '跨项目验收 orchard' }] },
  ]);
  service.replaceSession('host-a', { id: 's2', title: 'Beta', directory: '/beta', time: { updated: 20 } }, [
    { info: { id: 'm2', role: 'assistant', finish: 'stop', time: { created: 2 } }, parts: [{ type: 'text', text: '跨项目验收 garden' }] },
  ]);
  expect(service.search('host-a', '跨项目验收').map((hit) => [hit.sessionID, hit.directory, hit.title])).toEqual([
    ['s2', '/beta', 'Beta'], ['s1', '/alpha', 'Alpha'],
  ]);
  expect(service.search('host-b', '跨项目验收')).toEqual([]);
  expect(service.search('host-a', '跨项')).toHaveLength(2);
  service.removeSession('host-a', 's1');
  expect(service.search('host-a', 'orchard')).toEqual([]);
});
