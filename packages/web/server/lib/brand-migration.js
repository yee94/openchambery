import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// Read-only legacy inputs, supported for the Yuri 2.x migration window.
const LEGACY_ROOT_NAMES = ['openchamber', 'openchambery'];
const RESOURCES = [
  'settings.json', 'remote-clients.json', 'jwt-secret', 'ui-passkeys.json',
  'push-subscriptions.json', 'apns-tokens.json', 'git-identities.json',
  'sessions-directories.json', 'session-order.json', 'projects', 'quota',
  'assistants.sqlite', 'scheduled-task-runs.sqlite', 'session-index.sqlite',
  'message-queue.sqlite', 'transcript-cache.sqlite', 'assistant-workspaces',
  'prompt-attachments', 'message-queue-attachments', 'goals', 'speech',
  'themes', 'project-icons', 'sessions-metadata.json', 'magic-prompts.json',
  'github-auth.json', 'browser-provider-selection.json', 'content-search.sqlite',
];
const CREDENTIALS = new Set(['remote-clients.json', 'jwt-secret', 'ui-passkeys.json', 'push-subscriptions.json', 'apns-tokens.json']);

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function snapshot(source, target, validateJson = true) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('SYMLINK_REQUIRES_MANUAL_IMPORT');
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      if (validateJson && /(?:-wal|-shm|-journal)$/.test(name)) continue;
      snapshot(path.join(source, name), path.join(target, name), validateJson);
    }
    return;
  }
  if (!stat.isFile()) throw new Error('UNSUPPORTED_RESOURCE');
  if (validateJson && /\.(?:sqlite|sqlite3|db)$/.test(source)) {
    const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 5000 });
    try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
    const check = new Database(target, { readonly: true, fileMustExist: true });
    try {
      if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLITE_INTEGRITY_FAILED');
    } finally { check.close(); }
    fs.chmodSync(target, 0o600);
    return;
  }
  const bytes = fs.readFileSync(source);
  if (validateJson && source.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: stat.mode & 0o700 });
}

/** Copy owned Host state once per resource; never modify or remove the source. */
function migrateUnlocked({ target, sources }) {
  const results = [];
  for (const { source, markerName } of sources) {
    if (!exists(source)) continue;
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const marker = path.join(target, markerName);
    const completed = exists(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : {};
    const settingsSource = path.join(source, 'settings.json');
    const settingsTarget = path.join(target, 'settings.json');
    let identityMatches = !exists(settingsTarget);
    if (!identityMatches && exists(settingsSource) && [...CREDENTIALS].some((name) => !completed[name] && !exists(path.join(target, name)) && exists(path.join(source, name)))) {
      try {
        const oldSettings = JSON.parse(fs.readFileSync(settingsSource, 'utf8'));
        const newSettings = JSON.parse(fs.readFileSync(settingsTarget, 'utf8'));
        identityMatches = JSON.stringify(oldSettings) === JSON.stringify(newSettings)
          || Boolean(oldSettings.relaySigningKey && newSettings.relaySigningKey
            && JSON.stringify(oldSettings.relaySigningKey) === JSON.stringify(newSettings.relaySigningKey));
      } catch {
        results.push({ resource: 'settings.json', status: 'failed', code: 'IDENTITY_UNREADABLE' });
      }
    }
    for (const name of RESOURCES) {
      if (completed[name] || !exists(path.join(source, name))) continue;
      const destination = path.join(target, name);
      if (exists(destination)) {
        results.push({ resource: name, status: 'new-state-preserved' });
        completed[name] = 'new-state-preserved';
        continue;
      }
      if (CREDENTIALS.has(name) && !identityMatches) {
        results.push({ resource: name, status: 'identity-conflict' });
        if (!results.some((entry) => entry.resource === 'settings.json' && entry.status === 'failed')) {
          completed[name] = 'identity-conflict';
        }
        continue;
      }
      const staging = path.join(target, `.yuri-import-${crypto.randomUUID()}`);
      try {
        snapshot(path.join(source, name), staging, !['assistant-workspaces', 'prompt-attachments', 'message-queue-attachments', 'project-icons'].includes(name));
        if (exists(destination)) throw new Error('DESTINATION_CHANGED');
        if (fs.lstatSync(staging).isFile()) {
          fs.linkSync(staging, destination);
        } else {
          fs.renameSync(staging, destination);
        }
        completed[name] = 'imported';
        results.push({ resource: name, status: 'imported' });
      } catch (error) {
        results.push({ resource: name, status: 'failed', code: error.code || 'INVALID_RESOURCE' });
        if (name === 'settings.json') identityMatches = false;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    const stagingMarker = `${marker}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(stagingMarker, JSON.stringify(completed), { mode: 0o600, flag: 'wx' });
    fs.renameSync(stagingMarker, marker);
  }
  return results;
}

function withMigrationLock(target, migrate) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const lock = path.join(target, '.brand-migration.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Yuri migration lock is invalid; inspect it before retrying');
    let alive = true;
    try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another Yuri Host migration is active; retry after it completes');
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  try { return migrate(); } finally { fs.unlinkSync(lock); }
}

export function migrateHostBrandData({ homeDir = os.homedir(), env = process.env } = {}) {
  // Explicit data roots (including Preview) are isolated from release state.
  const target = path.join(homeDir, '.config', 'yuri');
  if (env.YURI_DATA_DIR?.trim() && path.resolve(env.YURI_DATA_DIR.trim()) !== target) return [];
  const sources = LEGACY_ROOT_NAMES.map((name) => ({
    source: path.join(homeDir, '.config', name), markerName: `.migration-${name}.json`,
  })).filter(({ source }) => exists(source));
  if (!sources.length) return [];
  return withMigrationLock(target, () => migrateUnlocked({ target, sources }));
}

/** Synchronous desktop coordinator hook; failures must stop profile startup. */
export function importHostBrandData({ sourceRoot, targetRoot }) {
  for (const root of [sourceRoot, targetRoot]) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Host import requires absolute source and target roots');
  }
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  const nested = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (nested(source, target) || nested(target, source)) throw new Error('Host import roots must be separate directories');
  for (const root of [source, target]) {
    let current = root;
    while (true) {
      if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Host import refuses symbolic-link roots');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!fs.statSync(source).isDirectory()) throw new Error('Host import source must be an existing directory');
  const markerName = `.migration-profile-${crypto.createHash('sha256').update(source).digest('hex')}.json`;
  const results = withMigrationLock(target, () => migrateUnlocked({ target, sources: [{ source, markerName }] }));
  const failed = results.filter(({ status }) => status === 'failed');
  if (failed.length) {
    const error = new Error(`Yuri Host profile import incomplete: ${failed.map(({ resource, code }) => `${resource} (${code})`).join(', ')}. Source data is preserved; correct it and retry.`);
    error.code = 'YURI_HOST_IMPORT_FAILED';
    error.results = results;
    throw error;
  }
  return results;
}
