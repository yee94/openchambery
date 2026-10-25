import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareDesktopMigration } from './brand-migration.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-profile-import-'));
  const source = path.join(root, 'OpenChamber');
  const target = path.join(root, 'Yuri');
  fs.mkdirSync(source);
  const options = { appData: root, userData: target, profile: 'release', verifySourceClosed() {} };
  try { return run({ source, target, options }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('SQLite import includes committed WAL and does not overwrite new state on retry', () => fixture(({ source, target, options }) => {
  const filename = 'message-queue.sqlite';
  const db = new DatabaseSync(path.join(source, filename));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE tasks (id TEXT); INSERT INTO tasks VALUES (\'queued\');');
  try {
    prepareDesktopMigration(options);
    const imported = new DatabaseSync(path.join(target, filename));
    try {
      expect(imported.prepare('SELECT id FROM tasks').get().id).toBe('queued');
      imported.exec("UPDATE tasks SET id = 'new-state'");
      prepareDesktopMigration(options);
      expect(imported.prepare('SELECT id FROM tasks').get().id).toBe('new-state');
    } finally { imported.close(); }
    expect(db.prepare('SELECT id FROM tasks').get().id).toBe('queued');
  } finally { db.close(); }
}));

test('corruption fails without a receipt or deleting original and remains retryable', () => fixture(({ source, target, options }) => {
  const file = path.join(source, 'message-queue.sqlite');
  fs.writeFileSync(file, 'corrupt');
  expect(() => prepareDesktopMigration(options)).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('corrupt');
  expect(fs.existsSync(path.join(target, 'yuri-desktop-migration-v1.json'))).toBe(false);
  fs.rmSync(file);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE tasks (id TEXT)');
  db.close();
  expect(prepareDesktopMigration(options)).toHaveProperty('snapshot');
}));

test('running-source protection prevents any new-profile writes', () => fixture(({ target, options }) => {
  expect(() => prepareDesktopMigration({ ...options, verifySourceClosed() { throw new Error('running'); } })).toThrow('running');
  expect(fs.existsSync(target)).toBe(false);
}));

test('isolated Host state requires its owning importer and cannot silently become empty', () => fixture(({ source, target, options }) => {
  fs.mkdirSync(path.join(source, 'openchamber-data'));
  expect(() => prepareDesktopMigration(options)).toThrow('profile-aware Host importer');
  expect(fs.existsSync(target)).toBe(false);
  let roots;
  prepareDesktopMigration({ ...options, migrateHostData(value) { roots = value; } });
  expect(roots).toEqual({ sourceRoot: path.join(source, 'openchamber-data'), targetRoot: path.join(target, 'yuri-data') });
}));

test('Preview never imports release profile and malformed receipt fails closed', () => fixture(({ target, options }) => {
  expect(prepareDesktopMigration({ ...options, profile: 'preview' })).toBe(null);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'yuri-desktop-migration-v1.json'), '{}');
  expect(() => prepareDesktopMigration(options)).toThrow('Invalid desktop migration receipt');
}));
