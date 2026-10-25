import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { prepareDesktopMigration } from '../../../electron/brand-migration.mjs';
import { importHostBrandData } from './brand-migration.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(profile = 'preview') {
  const appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-profile-import-')));
  roots.push(appData);
  const suffix = profile === 'dev' ? ' Dev' : ' Preview';
  const sourceRoot = path.join(appData, `OpenChamber${suffix}`, 'openchamber-data');
  const userData = path.join(appData, `Yuri${suffix}`);
  const targetRoot = path.join(userData, 'yuri-data');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const write = (name, value, root = sourceRoot) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  };
  const migrateHostData = vi.fn(importHostBrandData);
  const run = () => prepareDesktopMigration({ appData, userData, profile, verifySourceClosed: () => {}, migrateHostData });
  return { appData, sourceRoot, targetRoot, userData, write, migrateHostData, run };
}

describe('desktop coordinator → Host profile importer', () => {
  it.each(['preview', 'dev'])('imports only the selected %s Host profile with live WAL and credentials', (profile) => {
    const f = fixture(profile);
    f.write('settings.json', { profile, relaySigningKey: { privateJwk: 'fixture-private', publicJwk: 'fixture-public' } });
    f.write('remote-clients.json', { clients: [{ tokenHash: 'fixture-hash' }] });
    f.write('client-pairing-sessions.json', { sessions: ['transient'] });
    const release = path.join(f.appData, 'OpenChamber', 'openchamber-data');
    f.write('settings.json', { profile: 'release' }, release);
    const db = new Database(path.join(f.sourceRoot, 'message-queue.sqlite'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec("CREATE TABLE queued (body TEXT); INSERT INTO queued VALUES ('preserve pending work')");
      const plan = f.run();
      expect(f.migrateHostData).toHaveBeenCalledWith({ sourceRoot: f.sourceRoot, targetRoot: f.targetRoot });
      expect(JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'settings.json'))).profile).toBe(profile);
      expect(fs.readFileSync(path.join(f.targetRoot, 'remote-clients.json'))).toEqual(fs.readFileSync(path.join(f.sourceRoot, 'remote-clients.json')));
      expect(fs.existsSync(path.join(f.targetRoot, 'client-pairing-sessions.json'))).toBe(false);
      const copy = new Database(path.join(f.targetRoot, 'message-queue.sqlite'), { readonly: true });
      try { expect(copy.prepare('SELECT body FROM queued').get().body).toBe('preserve pending work'); } finally { copy.close(); }
      expect(db.prepare('SELECT count(*) AS count FROM queued').get().count).toBe(1);
      expect(fs.existsSync(plan.snapshot)).toBe(true);
      expect(fs.existsSync(plan.marker)).toBe(false);
      fs.unlinkSync(path.join(f.targetRoot, 'remote-clients.json'));
      f.run();
      expect(fs.existsSync(path.join(f.targetRoot, 'remote-clients.json'))).toBe(false);
    } finally { db.close(); }
  });

  it('preserves existing target state and does not import credentials for a foreign Host identity', () => {
    const f = fixture();
    f.write('settings.json', { relaySigningKey: { privateJwk: 'old' } });
    f.write('settings.json', { relaySigningKey: { privateJwk: 'new' } }, f.targetRoot);
    f.write('remote-clients.json', { clients: ['old'] });
    f.write('session-order.json', { sessions: ['new'] }, f.targetRoot);
    f.write('session-order.json', { sessions: ['old'] });
    f.run();
    expect(JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'settings.json'))).relaySigningKey.privateJwk).toBe('new');
    expect(JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'session-order.json'))).sessions).toEqual(['new']);
    expect(fs.existsSync(path.join(f.targetRoot, 'remote-clients.json'))).toBe(false);
  });

  it('stops before desktop snapshot/receipt on corrupt Host data and retries without losing source or completed resources', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.sourceRoot, 'settings.json'), '{broken');
    f.write('session-order.json', { sessions: ['keep'] });
    expect(f.run).toThrow(/Host profile import incomplete/);
    expect(fs.existsSync(path.join(f.userData, 'migration-source-v1'))).toBe(false);
    expect(fs.existsSync(path.join(f.userData, 'yuri-desktop-migration-v1.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.targetRoot, 'settings.json'))).toBe(false);
    expect(fs.readFileSync(path.join(f.sourceRoot, 'settings.json'), 'utf8')).toBe('{broken');
    expect(JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'session-order.json'))).sessions).toEqual(['keep']);
    f.write('settings.json', { repaired: true });
    expect(f.run().snapshot).toBe(path.join(f.userData, 'migration-source-v1'));
    expect(JSON.parse(fs.readFileSync(path.join(f.targetRoot, 'settings.json'))).repaired).toBe(true);
  });

  it('rejects missing, overlapping and symlink roots before creating replacement state', () => {
    const f = fixture();
    expect(() => importHostBrandData({ sourceRoot: path.join(f.appData, 'missing'), targetRoot: f.targetRoot })).toThrow();
    expect(fs.existsSync(f.targetRoot)).toBe(false);
    expect(() => importHostBrandData({ sourceRoot: f.sourceRoot, targetRoot: path.join(f.sourceRoot, 'nested') })).toThrow(/separate directories/);
    const link = path.join(f.appData, 'linked-source');
    fs.symlinkSync(f.sourceRoot, link);
    expect(() => importHostBrandData({ sourceRoot: link, targetRoot: f.targetRoot })).toThrow(/symbolic-link roots/);
    expect(fs.existsSync(f.targetRoot)).toBe(false);
  });
});
