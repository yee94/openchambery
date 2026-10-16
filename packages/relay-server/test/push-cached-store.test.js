import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCachedTokenStore } from '../src/push/cached-store.js';

it('loads existing SQLite bindings, keeps reads in memory, and commits before acknowledging writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-cache-'));
  const databasePath = path.join(directory, 'tokens.sqlite');
  const seed = new DatabaseSync(databasePath);
  seed.exec('CREATE TABLE push_tokens (token TEXT PRIMARY KEY, server_id TEXT NOT NULL, platform TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT');
  seed.exec('BEGIN');
  const insert = seed.prepare('INSERT INTO push_tokens VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 100_000; index += 1) insert.run(String(index), 'host', 'ios', index);
  seed.exec('COMMIT');
  seed.close();
  const store = createCachedTokenStore(databasePath, { maxTokens: 100_000 });
  let observer;
  try {
    await store.ready();
    expect(store.count()).toBe(100_000);
    observer = new DatabaseSync(databasePath);
    observer.exec('BEGIN IMMEDIATE');
    const previous = store.get('0');
    const writing = store.upsert('0', 'new-host', 'ios', 123);
    const failure = expect(writing).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    let matches = 0;
    for (let index = 0; index < 100_000; index += 1) if (store.get(String(index)).serverId === 'host') matches += 1;
    expect(matches).toBe(100_000);
    await failure;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(store.get('0')).toBe(previous);
    observer.exec('ROLLBACK');
    await store.upsert('0', 'new-host', 'ios', 123);
    expect(observer.prepare('SELECT server_id FROM push_tokens WHERE token = ?').get('0').server_id).toBe('new-host');
    await store.delete('0', previous);
    expect(store.get('0').serverId).toBe('new-host');
    await store.delete('0', store.get('0'));
    expect(store.count()).toBe(99_999);
    expect(observer.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n).toBe(99_999);
  } finally {
    observer?.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('bounds queued writes and token capacity without dropping existing bindings', async () => {
  const store = createCachedTokenStore(':memory:', { maxTokens: 1, maxPending: 1 });
  try {
    await store.ready();
    const first = store.upsert('a', 'host', 'ios', 1);
    await expect(store.upsert('b', 'host', 'ios', 1)).rejects.toMatchObject({ code: 'PUSH_STORE_BUSY' });
    await first;
    await expect(store.upsert('b', 'host', 'ios', 1)).rejects.toMatchObject({ code: 'PUSH_STORE_BUSY' });
    expect(store.count()).toBe(1);
    expect(store.get('a').serverId).toBe('host');
  } finally { await store.close(); }
});

it('fails closed on startup failure and cancels initialization on close', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-cache-invalid-'));
  const invalid = createCachedTokenStore(directory, { maxTokens: 1 });
  const closing = createCachedTokenStore(':memory:', { maxTokens: 1 });
  try {
    await expect(invalid.ready()).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    expect(() => invalid.get('a')).toThrow('unavailable');
    await expect(invalid.ready()).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    const starting = expect(closing.ready()).rejects.toMatchObject({ code: 'PUSH_STORE_UNAVAILABLE' });
    await Promise.resolve();
    await closing.close();
    await starting;
  } finally {
    await Promise.all([invalid.close(), closing.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
