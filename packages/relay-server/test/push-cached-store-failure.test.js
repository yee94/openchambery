import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const threads = vi.hoisted(() => []);
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args) { super(...args); threads.push(this); }
    },
  };
});

import { createCachedTokenStore } from '../src/push/cached-store.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(threads.splice(0).map((worker) => worker.terminate()));
});

it('times out stalled writes, invalidates uncertain state, and reloads after a bounded recovery cooldown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-cache-recovery-'));
  const store = createCachedTokenStore(path.join(directory, 'tokens.sqlite'), { maxTokens: 2 });
  try {
    await store.ready();
    await store.upsert('a', 'host', 'ios', 1);
    const worker = threads.at(-1);
    vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const write = expect(store.upsert('a', 'changed', 'ios', 2)).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    const queued = expect(store.upsert('b', 'host', 'ios', 2)).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.all([write, queued]);
    expect(() => store.get('a')).toThrow('unavailable');
    await expect(store.ready()).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(5_001);
    await store.ready();
    expect(threads).toHaveLength(2);
    expect(store.count()).toBe(1);
    expect(store.get('a').serverId).toBe('host');
    expect(store.get('b')).toBeNull();
    await store.upsert('a', 'restored', 'ios', 3);
    expect(store.get('a').serverId).toBe('restored');
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('does not issue worker messages for warm reads, counts, or obsolete token deletion', async () => {
  const store = createCachedTokenStore(':memory:', { maxTokens: 2 });
  try {
    await store.ready();
    await store.upsert('a', 'host', 'ios', 1);
    const old = store.get('a');
    await store.upsert('a', 'next-host', 'ios', 2);
    const post = vi.spyOn(threads.at(-1), 'postMessage');
    for (let index = 0; index < 1_000; index += 1) {
      store.get('a');
      store.count();
    }
    await store.delete('a', old);
    expect(post).not.toHaveBeenCalled();
    expect(store.get('a').serverId).toBe('next-host');
  } finally { await store.close(); }
});
