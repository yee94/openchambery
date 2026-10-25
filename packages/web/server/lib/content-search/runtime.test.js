import { expect, test } from 'vitest';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('persists initialization times only after all thirty-day history is covered and resumes partial work', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  const day = 86400000;
  let clock = 40 * day;
  let fail = true;
  const reads = [];
  const dependencies = { service, getRuntimeKey: () => 'host', now: () => clock,
    listSessions: async () => ({ data: ['a', 'b'].map((id) => ({ id, time: { updated: 40 * day } })), cursor: {} }),
    listMessages: async ({ sessionID }) => {
      reads.push(sessionID);
      if (sessionID === 'b' && fail) throw new Error('offline');
      return { data: [{ type: 'user', id: sessionID, sessionID, time: { created: 12 * day }, text: 'old history' }], cursor: {} };
    },
  };
  let runtime = createContentSearchRuntime(dependencies);
  expect(runtime.status().initializationRequired).toBe(true);
  await runtime.sync();
  expect(runtime.status()).toMatchObject({ phase: 'partial', initializationRequired: true, indexStartedAt: clock, indexCompletedAt: null });
  await runtime.stop();
  clock += 1000;
  fail = false;
  runtime = createContentSearchRuntime(dependencies);
  await runtime.sync();
  expect(reads).toEqual(['a', 'b', 'b']);
  expect(runtime.status()).toMatchObject({ phase: 'ready', initializationRequired: false, indexStartedAt: 40 * day, indexCompletedAt: clock });
  expect(service.search('host', 'old history')).toHaveLength(2);
  await runtime.stop();
  runtime = createContentSearchRuntime(dependencies);
  expect(runtime.status()).toMatchObject({ initializationRequired: false, indexCompletedAt: clock });
  service.removeSession('host', 'a');
  await runtime.sync();
  expect(reads).toEqual(['a', 'b', 'b', 'a']);
  expect(service.search('host', 'old history')).toHaveLength(2);
  await runtime.stop(); service.close();
});

test('expired rows cannot leave a checkpoint claiming coverage that was pruned', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  service.replaceSession('host', { id: 's', time: { updated: 10 } }, [], 1);
  service.prune('host', 5, new Set(['s']));
  expect(service.updated('host', 's', 1)).toBeUndefined();
  expect(service.updated('host', 's', 5)).toBe(10);
  service.close();
});

test('catalog failure and malformed pages never certify coverage or remove existing results', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  service.replaceSession('host', { id: 's', time: { updated: 10 } }, [
    { info: { id: 'm', role: 'user', time: { created: 10 } }, parts: [{ type: 'text', text: 'preserved' }] },
  ], 0);
  for (const data of [undefined, [{ id: 'bad' }]]) {
    const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 100,
      listSessions: async () => ({ data, cursor: {} }), listMessages: async () => { throw new Error('unexpected'); },
    });
    await runtime.sync();
    expect(runtime.status()).toMatchObject({ phase: 'error', initializationRequired: true, indexCompletedAt: null });
    expect(service.search('host', 'preserved')).toHaveLength(1);
    await runtime.stop();
  }
  const empty = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 200,
    listSessions: async () => ({ data: [], cursor: {} }), listMessages: async () => { throw new Error('unexpected'); },
  });
  await empty.sync();
  expect(empty.status()).toMatchObject({ phase: 'ready', initializationRequired: false, indexCompletedAt: 200, messages: 0 });
  await empty.stop(); service.close();
});

test('a large warm catalog verifies without rereading transcripts and backfill keeps two-worker concurrency', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  const sessions = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), time: { updated: 10 } }));
  let reads = 0;
  let active = 0;
  let peak = 0;
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 100,
    listSessions: async ({ cursor }) => {
      const start = Number(cursor ?? 0);
      return { data: sessions.slice(start, start + 100), cursor: { next: start + 100 < sessions.length ? String(start + 100) : undefined } };
    },
    listMessages: async () => {
      reads++; peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { data: [], cursor: {} };
    },
  });
  await runtime.sync();
  expect(runtime.status()).toMatchObject({ initializationRequired: false, completed: 1000 });
  expect(peak).toBe(2);
  expect(reads).toBe(1000);
  await runtime.sync();
  expect(reads).toBe(1000);
  await runtime.stop(); service.close();
});

test('expands existing seven-day checkpoints to thirty days even when sessions are unchanged', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  const day = 86400000;
  const now = 40 * day;
  const session = { id: 's', directory: '/project', time: { updated: now } };
  service.replaceSession('host', session, [], now - 7 * day);
  let reads = 0;
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => now,
    listSessions: async () => ({ data: [session], cursor: {} }),
    listMessages: async () => {
      reads++;
      return { data: [10, 29, 31].map((age) => ({ type: 'user', id: `m${age}`, sessionID: 's', time: { created: now - age * day }, text: `history ${age}` })), cursor: {} };
    },
  });
  await runtime.sync();
  expect(service.search('host', 'history').map((hit) => hit.messageID)).toEqual(['m10']);
  expect(service.search('host', 'history 29').map((hit) => hit.messageID)).toEqual(['m29']);
  expect(service.search('host', 'history 31')).toEqual([]);
  expect(runtime.status().since).toBe(now - 30 * day);
  await runtime.sync();
  expect(reads).toBe(1);
  await runtime.stop(); service.close();
});

test('pages older messages, excludes expired text, and reuses checkpoints after restarting', async () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  const now = 31 * 24 * 60 * 60 * 1000;
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
  expect(service.search('host', 'needle').map((hit) => hit.messageID)).toEqual(['latest']);
  expect(service.search('host', 'needle older').map((hit) => hit.messageID)).toEqual(['older']);
  expect(service.search('host', 'needle expired')).toEqual([]);
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
  expect(service.coverage('one').indexCompletedAt).toBeNull();
  expect(runtime.status()).toMatchObject({ runtime: 'two', initializationRequired: true, indexStartedAt: null, indexCompletedAt: null });
  await runtime.stop(); service.close();
});
