import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  OPENCODE_AGENTS_SYNC_BACKUP_DIR,
  OPENCODE_AUTH_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS,
} from './constants.js';
import { sanitizeSyncRunIdForPath } from './scripts.js';

const copyPathIfExists = async (from, to) => {
  try {
    await fsp.access(from);
  } catch {
    return false;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.cp(from, to, { recursive: true, force: true });
  return true;
};

const pruneGenerations = async (backupRoot, syncRunId, generations) => {
  await fsp.mkdir(backupRoot, { recursive: true });
  let entries = [];
  try {
    entries = await fsp.readdir(backupRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(backupRoot, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fsp.stat(abs)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    dirs.push({ name: entry.name, abs, mtimeMs });
  }
  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const [index, entry] of dirs.entries()) {
    if (index < generations) continue;
    if (entry.name === syncRunId) continue;
    await fsp.rm(entry.abs, { recursive: true, force: true });
  }
};

/**
 * Local (pull destination) generational backup + delete stale counterparts.
 * Mirrors remote prepare semantics under the local home.
 *
 * @param {string} homedir
 * @param {object} plan
 * @param {{ syncRunId: string, generations?: number }} options
 */
export const prepareLocalSyncDestination = async (homedir, plan, options) => {
  const home = String(homedir || '');
  const syncRunId = sanitizeSyncRunIdForPath(options?.syncRunId);
  const generations = Number.isFinite(options?.generations) && Number(options.generations) > 0
    ? Math.trunc(Number(options.generations))
    : OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS;
  const configDir = path.join(home, '.config', 'opencode');
  const backupRoot = path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR);
  const runBackup = path.join(backupRoot, syncRunId);

  await fsp.mkdir(configDir, { recursive: true });
  await fsp.rm(runBackup, { recursive: true, force: true });
  await fsp.mkdir(runBackup, { recursive: true });
  await pruneGenerations(backupRoot, syncRunId, generations);

  const backupPaths = [
    ...(Array.isArray(plan?.files) ? plan.files.map((entry) => entry.path) : []),
    ...(Array.isArray(plan?.directories) ? plan.directories.map((entry) => entry.path) : []),
  ];
  for (const rel of backupPaths) {
    await copyPathIfExists(path.join(configDir, rel), path.join(runBackup, rel));
  }

  const directoryDeleteNames = new Set();
  for (const dirSpec of OPENCODE_CONFIG_SYNC_ALLOWLIST.directories) {
    directoryDeleteNames.add(dirSpec.path);
    if (typeof dirSpec.legacy === 'string' && dirSpec.legacy) {
      directoryDeleteNames.add(dirSpec.legacy);
    }
  }
  for (const rel of Array.isArray(plan?.deletes) ? plan.deletes : []) {
    const abs = path.join(configDir, rel);
    if (directoryDeleteNames.has(rel)) {
      await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.rm(abs, { force: true });
    }
  }

  if (plan?.agentsRoot) {
    const agentsBackupRoot = path.join(home, OPENCODE_AGENTS_SYNC_BACKUP_DIR);
    const agentsRun = path.join(agentsBackupRoot, syncRunId);
    await fsp.rm(agentsRun, { recursive: true, force: true });
    await fsp.mkdir(agentsRun, { recursive: true });
    await pruneGenerations(agentsBackupRoot, syncRunId, generations);
    await copyPathIfExists(path.join(home, '.agents'), path.join(agentsRun, 'agents'));
    await fsp.rm(path.join(home, '.agents'), { recursive: true, force: true });
  }

  if (plan?.authFile) {
    const authBackupRoot = path.join(home, OPENCODE_AUTH_SYNC_BACKUP_DIR);
    const authRun = path.join(authBackupRoot, syncRunId);
    await fsp.rm(authRun, { recursive: true, force: true });
    await fsp.mkdir(authRun, { recursive: true });
    await pruneGenerations(authBackupRoot, syncRunId, generations);
    await copyPathIfExists(
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      path.join(authRun, 'auth.json'),
    );
  }

  return { runBackup };
};

/**
 * Confirm local pull backup generation exists.
 * @param {string} homedir
 * @param {{ syncRunId: string }} options
 */
export const finalizeLocalSyncDestination = async (homedir, options) => {
  const syncRunId = sanitizeSyncRunIdForPath(options?.syncRunId);
  const runBackup = path.join(
    String(homedir || ''),
    '.config',
    'opencode',
    OPENCODE_CONFIG_SYNC_BACKUP_DIR,
    syncRunId,
  );
  const st = await fsp.stat(runBackup);
  if (!st.isDirectory()) {
    throw new Error('Local sync finalize missing backup generation');
  }
  return { ok: true };
};

/**
 * Extract a tar.gz buffer into a destination directory.
 * @param {Buffer} buffer
 * @param {string} destinationDir
 */
export const extractTarGzBuffer = (buffer, destinationDir) => new Promise((resolve, reject) => {
  fs.mkdirSync(destinationDir, { recursive: true });
  const child = spawn('tar', ['-xzf', '-', '-C', destinationDir], {
    stdio: ['pipe', 'ignore', 'pipe'],
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error((stderr || 'Local tar extract failed').trim()));
      return;
    }
    resolve();
  });
  child.stdin?.end(buffer);
});
