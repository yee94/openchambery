import { expect, test } from 'vitest';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('pages older messages, excludes expired text, and reuses checkpoints after restarting', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  const now = 8 * 24 * 60 * 60 * 1000;
  let reads = 0;
  const dependencies = { service, getRuntimeKey: () => 'host', now: () => now,
    listSessions: async () => ({ data: [{ id: 's', directory: '/project', time: { updated: now } }], cursor: {} }),
    listMessages: async ({ cursor }) => {
      reads++;
      return { data: [{ type: 'user', id: cursor ?? 'latest', sessionID: 's', time: { created: cursor === 'expired' ? 1 : now - reads }, text: `needle ${cursor ?? 'latest'}` }], cursor: { next: cursor === 'expired' ? null : cursor ? 'expired' : 'older' } };
    },
  };
  const runtime = createContentSearchRuntime(dependencies);
  await runtime.sync();
  expect(service.search('host', 'needle').map((hit) => hit.messageID)).toEqual(['latest', 'older']);
  expect(reads).toBe(3);
  await runtime.stop();
  const restarted = createContentSearchRuntime(dependencies);
  await restarted.sync();
  expect(reads).toBe(3);
  await restarted.stop(); service.close();
});

test('backfills unvisited global sessions across cursor pages and refreshes new messages without UI', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  let version = 1;
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 1000,
    listSessions: async ({ cursor }) => ({ data: [{ id: cursor ? 's2' : 's1', directory: cursor ? '/two' : '/one', title: 'unvisited', time: { updated: version } }], cursor: { next: cursor ? null : 'next' } }),
    listMessages: async ({ sessionID }) => ({ data: [{ type: 'user', id: `${sessionID}-${version}`, sessionID, time: { created: 900 }, text: `global needle ${version}` }], cursor: {} }),
  });
  await runtime.sync();
  expect(service.search('host', 'needle')).toHaveLength(2);
  expect(runtime.status().phase).toBe('ready');
  version = 2;
  await runtime.sync();
  expect(service.search('host', 'needle 2')).toHaveLength(2);
  expect(service.search('host', 'needle 1')).toEqual([]);
  await runtime.stop();
  service.close();
});

test('a failed refresh preserves previous hits and retries without erasing other sessions', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  let version = 1;
  let fail = false;
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 1000,
    listSessions: async () => ({ data: ['s1', 's2'].map((id) => ({ id, directory: '/repo', time: { updated: version } })), cursor: {} }),
    listMessages: async ({ sessionID }) => {
      if (fail && sessionID === 's2') throw new Error('offline');
      return { data: [{ type: 'user', id: sessionID, sessionID, time: { created: 900 }, text: `version${version}` }], cursor: {} };
    },
  });
  await runtime.sync();
  version = 2; fail = true;
  await runtime.sync();
  expect(runtime.status().phase).toBe('partial');
  expect(service.search('host', 'version1').map((hit) => hit.sessionID)).toEqual(['s2']);
  expect(service.search('host', 'version2').map((hit) => hit.sessionID)).toEqual(['s1']);
  fail = false;
  await runtime.sync();
  expect(runtime.status().phase).toBe('ready');
  expect(service.search('host', 'version2')).toHaveLength(2);
  await runtime.stop(); service.close();
});

test('runtime switch rejects in-flight message pages', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  let host = 'one';
  let finish;
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => host, now: () => 1000,
    listSessions: async () => ({ data: [{ id: 's1', directory: '/repo', time: { updated: 1 } }], cursor: {} }),
    listMessages: () => { started(); return new Promise((resolve) => { finish = resolve; }); },
  });
  const work = runtime.sync();
  await fetching;
  host = 'two';
  finish({ data: [{ type: 'user', id: 'm1', sessionID: 's1', time: { created: 900 }, text: 'stale answer' }], cursor: {} });
  await work;
  expect(service.search('one', 'stale')).toEqual([]);
  expect(service.search('two', 'stale')).toEqual([]);
  await runtime.stop(); service.close();
});
