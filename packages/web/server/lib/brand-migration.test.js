import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateHostBrandData } from './brand-migration.js';

const homes = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-import-test-'));
  homes.push(home);
  const old = path.join(home, '.config', 'openchamber');
  const current = path.join(home, '.config', 'yuri');
  fs.mkdirSync(old, { recursive: true });
  const write = (name, value, root = old) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, name), JSON.stringify(value)); };
  return { home, old, current, write, run: (env = {}) => migrateHostBrandData({ homeDir: home, env }) };
}

describe('Host brand import', () => {
  it('preserves identity and credentials, omits transient pairing, and is idempotent after deletion', () => {
    const f = setup();
    f.write('settings.json', { relaySigningKey: { privateJwk: 'private', publicJwk: 'public' } });
    f.write('remote-clients.json', { clients: [{ tokenHash: 'hash' }] });
    f.write('client-pairing-sessions.json', { sessions: ['one-time'] });
    f.write('relay-host.lock', { pid: 123 });
    expect(f.run().filter((r) => r.status === 'imported')).toHaveLength(2);
    expect(fs.readFileSync(path.join(f.current, 'settings.json'))).toEqual(fs.readFileSync(path.join(f.old, 'settings.json')));
    expect(fs.existsSync(path.join(f.current, 'client-pairing-sessions.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.current, 'relay-host.lock'))).toBe(false);
    fs.unlinkSync(path.join(f.current, 'remote-clients.json'));
    expect(f.run()).toEqual([]);
    expect(fs.existsSync(path.join(f.current, 'remote-clients.json'))).toBe(false);
  });

  it('keeps new state authoritative and does not bind old credentials to another identity', () => {
    const f = setup();
    f.write('settings.json', { relaySigningKey: { privateJwk: 'old' } });
    f.write('settings.json', { relaySigningKey: { privateJwk: 'new' } }, f.current);
    f.write('remote-clients.json', { clients: ['old'] });
    expect(f.run()).toContainEqual({ resource: 'remote-clients.json', status: 'identity-conflict' });
    expect(JSON.parse(fs.readFileSync(path.join(f.current, 'settings.json'))).relaySigningKey.privateJwk).toBe('new');
    expect(fs.existsSync(path.join(f.current, 'remote-clients.json'))).toBe(false);
  });

  it('retries malformed resources without losing unrelated imports or the old data', () => {
    const f = setup();
    fs.writeFileSync(path.join(f.old, 'settings.json'), '{broken');
    f.write('remote-clients.json', { clients: [] });
    f.write('session-order.json', { sessions: ['first'] });
    expect(f.run()).toContainEqual({ resource: 'settings.json', status: 'failed', code: 'INVALID_RESOURCE' });
    expect(fs.readFileSync(path.join(f.old, 'settings.json'), 'utf8')).toBe('{broken');
    expect(fs.existsSync(path.join(f.current, 'session-order.json'))).toBe(true);
    f.write('settings.json', { fixed: true });
    expect(f.run().filter((r) => r.status === 'imported')).toHaveLength(2);
  });

  it('takes a consistent snapshot of live SQLite WAL state', () => {
    const f = setup();
    const db = new Database(path.join(f.old, 'message-queue.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec("CREATE TABLE queue (body TEXT); INSERT INTO queue VALUES ('unsent message')");
      expect(f.run()).toContainEqual({ resource: 'message-queue.sqlite', status: 'imported' });
      const imported = new Database(path.join(f.current, 'message-queue.sqlite'), { readonly: true });
      try { expect(imported.prepare('SELECT body FROM queue').get().body).toBe('unsent message'); } finally { imported.close(); }
      expect(db.prepare('SELECT count(*) AS n FROM queue').get().n).toBe(1);
    } finally { db.close(); }
  });

  it('isolates Preview/custom roots and rejects symlink imports without deleting their targets', () => {
    const f = setup();
    f.write('settings.json', { existing: true });
    expect(f.run({ YURI_DATA_DIR: path.join(f.home, 'preview') })).toEqual([]);
    fs.symlinkSync(path.join(f.old, 'settings.json'), path.join(f.old, 'remote-clients.json'));
    expect(f.run()).toContainEqual({ resource: 'remote-clients.json', status: 'failed', code: 'INVALID_RESOURCE' });
    expect(fs.existsSync(path.join(f.old, 'settings.json'))).toBe(true);
  });
});
