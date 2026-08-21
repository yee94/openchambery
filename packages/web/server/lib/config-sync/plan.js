import fs from 'node:fs';
import path from 'node:path';

import {
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_MAX_BYTES,
  OPENCODE_CONFIG_SYNC_MAX_FILES,
  SYNC_DIRECTION_PUSH,
  SYNC_DIRECTIONS,
} from './constants.js';
import { filterPlanBySelections, normalizeSyncSelections } from './selections.js';

/**
 * Walk an allowlist directory with symlink dereference (fs.stat), cycle-guard, excludeNames, and `.backup` skip.
 * @param {string} absPath
 * @param {Set<string>} excludeNames
 * @param {Set<string>} seenRealpaths
 * @returns {{ fileCount: number, bytes: number }}
 */
export const walkAllowlistDirectory = (absPath, excludeNames, seenRealpaths) => {
  let real;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return { fileCount: 0, bytes: 0 };
  }
  if (seenRealpaths.has(real)) return { fileCount: 0, bytes: 0 };
  seenRealpaths.add(real);

  let fileCount = 0;
  let bytes = 0;
  let names;
  try {
    names = fs.readdirSync(absPath);
  } catch {
    return { fileCount: 0, bytes: 0 };
  }

  for (const name of names) {
    if (excludeNames.has(name) || name === 'node_modules') continue;
    if (/\.backup$/.test(name)) continue;
    const childAbs = path.join(absPath, name);
    let st;
    try {
      st = fs.statSync(childAbs);
    } catch {
      // Broken symlink or unreadable entry — skip.
      continue;
    }
    if (st.isDirectory()) {
      const nested = walkAllowlistDirectory(childAbs, excludeNames, seenRealpaths);
      fileCount += nested.fileCount;
      bytes += nested.bytes;
    } else if (st.isFile()) {
      fileCount += 1;
      bytes += st.size;
    }
  }
  return { fileCount, bytes };
};

/**
 * Pure planner: source-home allowlist + optional `~/.agents` + optional provider auth.json.
 * Plan is computed on the source side; executors run it on the target side.
 * `direction` is a first-class field (`push` today; `pull` reuses the same shape).
 *
 * @param {string} sourceHomedir
 * @param {{
 *   direction?: 'push' | 'pull',
 *   syncRunId?: string,
 *   sourceTargetId?: string,
 *   targetId?: string,
 *   includeAuthFile?: boolean,
 *   selections?: import('./selections.js').SyncSelections,
 * }} [options]
 * @returns {{
 *   direction: 'push' | 'pull',
 *   syncRunId?: string,
 *   sourceTargetId?: string,
 *   targetId?: string,
 *   files: { path: string, bytes: number }[],
 *   directories: { path: string, fileCount: number, bytes: number }[],
 *   agentsRoot: { fileCount: number, bytes: number } | null,
 *   authFile: { bytes: number } | null,
 *   deletes: string[],
 *   totalBytes: number,
 *   selections?: import('./selections.js').SyncSelections,
 * }}
 */
export const planOpenCodeConfigSync = (sourceHomedir, options = {}) => {
  const home = String(sourceHomedir || '');
  const direction = options.direction || SYNC_DIRECTION_PUSH;
  if (!SYNC_DIRECTIONS.includes(direction)) {
    throw new Error(`Unsupported sync direction: ${String(direction)}`);
  }
  // Credential transfer requires an explicit per-target grant (ticket 03).
  // Callers that have not authorized the target pass includeAuthFile: false so
  // auth.json is skipped rather than failing the whole sync.
  const selections = options.selections
    ? normalizeSyncSelections(options.selections, { includeAuthFile: options.selections.authFile === true })
    : null;
  const includeAuthFile = selections
    ? selections.authFile === true
    : options.includeAuthFile !== false;

  const root = path.join(home, '.config', 'opencode');
  /** @type {{ path: string, bytes: number }[]} */
  const files = [];
  /** @type {{ path: string, fileCount: number, bytes: number }[]} */
  const directories = [];
  /** @type {string[]} */
  const deletes = [];
  let totalBytes = 0;
  let totalFileCount = 0;

  for (const group of OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups) {
    let winner = null;
    for (const member of group) {
      const abs = path.join(root, member);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      winner = { path: member, bytes: st.size };
      break;
    }
    if (!winner) continue;
    files.push(winner);
    totalBytes += winner.bytes;
    totalFileCount += 1;
    for (const member of group) {
      if (member !== winner.path) deletes.push(member);
    }
  }

  for (const name of OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles) {
    const abs = path.join(root, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files.push({ path: name, bytes: st.size });
    totalBytes += st.size;
    totalFileCount += 1;
  }

  for (const dirSpec of OPENCODE_CONFIG_SYNC_ALLOWLIST.directories) {
    const abs = path.join(root, dirSpec.path);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const excludeNames = new Set(Array.isArray(dirSpec.excludeNames) ? dirSpec.excludeNames : []);
    const walked = walkAllowlistDirectory(abs, excludeNames, new Set());
    directories.push({
      path: dirSpec.path,
      fileCount: walked.fileCount,
      bytes: walked.bytes,
    });
    totalBytes += walked.bytes;
    totalFileCount += walked.fileCount;
    deletes.push(dirSpec.path);
    if (typeof dirSpec.legacy === 'string' && dirSpec.legacy) {
      deletes.push(dirSpec.legacy);
    }
  }

  /** @type {{ fileCount: number, bytes: number } | null} */
  let agentsRoot = null;
  const agentsAbs = path.join(home, '.agents');
  let agentsStat;
  try {
    agentsStat = fs.statSync(agentsAbs);
  } catch {
    agentsStat = null;
  }
  if (agentsStat?.isDirectory()) {
    const walked = walkAllowlistDirectory(agentsAbs, new Set(), new Set());
    agentsRoot = { fileCount: walked.fileCount, bytes: walked.bytes };
    totalBytes += walked.bytes;
    totalFileCount += walked.fileCount;
  }

  /** @type {{ bytes: number } | null} */
  let authFile = null;
  if (includeAuthFile) {
    const authAbs = path.join(home, '.local', 'share', 'opencode', 'auth.json');
    let authStat;
    try {
      // fs.stat follows symlinks (auth.json is sometimes a symlink).
      authStat = fs.statSync(authAbs);
    } catch {
      authStat = null;
    }
    if (authStat?.isFile()) {
      authFile = { bytes: authStat.size };
      totalBytes += authStat.size;
      // Single credential file — does not count against the 20000 file-count cap.
    }
  }

  if (totalBytes > OPENCODE_CONFIG_SYNC_MAX_BYTES || totalFileCount > OPENCODE_CONFIG_SYNC_MAX_FILES) {
    throw new Error('OpenCode config sync exceeds size limit (512MB)');
  }

  const full = {
    direction,
    ...(typeof options.syncRunId === 'string' && options.syncRunId ? { syncRunId: options.syncRunId } : {}),
    ...(typeof options.sourceTargetId === 'string' && options.sourceTargetId
      ? { sourceTargetId: options.sourceTargetId }
      : {}),
    ...(typeof options.targetId === 'string' && options.targetId ? { targetId: options.targetId } : {}),
    files,
    directories,
    agentsRoot,
    authFile,
    deletes,
    totalBytes,
  };
  return selections ? filterPlanBySelections(full, selections) : full;
};

/**
 * Build a pull plan from a remote inventory payload (no local filesystem walk).
 * @param {object} inventory
 * @param {{
 *   direction?: 'pull',
 *   syncRunId?: string,
 *   sourceTargetId?: string,
 *   targetId?: string,
 *   includeAuthFile?: boolean,
 *   selections?: import('./selections.js').SyncSelections,
 * }} [options]
 */
export const planOpenCodeConfigSyncFromInventory = (inventory, options = {}) => {
  const direction = options.direction || 'pull';
  if (!SYNC_DIRECTIONS.includes(direction)) {
    throw new Error(`Unsupported sync direction: ${String(direction)}`);
  }
  const selections = options.selections
    ? normalizeSyncSelections(options.selections, { includeAuthFile: options.selections.authFile === true })
    : null;
  const includeAuthFile = selections
    ? selections.authFile === true
    : options.includeAuthFile !== false;

  const files = Array.isArray(inventory?.files) ? inventory.files.filter((entry) => entry?.path) : [];
  const directories = Array.isArray(inventory?.directories)
    ? inventory.directories.filter((entry) => entry?.path)
    : [];
  const agentsRoot = inventory?.agentsRoot && typeof inventory.agentsRoot === 'object'
    ? inventory.agentsRoot
    : null;
  const authFile = includeAuthFile && inventory?.authFile && typeof inventory.authFile === 'object'
    ? inventory.authFile
    : null;

  /** @type {string[]} */
  const deletes = [];
  for (const group of OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups) {
    const winner = files.find((entry) => group.includes(entry.path));
    if (!winner) continue;
    for (const member of group) {
      if (member !== winner.path) deletes.push(member);
    }
  }
  for (const dir of directories) {
    deletes.push(dir.path);
    const spec = OPENCODE_CONFIG_SYNC_ALLOWLIST.directories.find((entry) => entry.path === dir.path);
    if (typeof spec?.legacy === 'string' && spec.legacy) deletes.push(spec.legacy);
  }

  let totalBytes = 0;
  let totalFileCount = 0;
  for (const entry of files) {
    totalBytes += Number(entry.bytes) || 0;
    totalFileCount += 1;
  }
  for (const entry of directories) {
    totalBytes += Number(entry.bytes) || 0;
    totalFileCount += Number(entry.fileCount) || 0;
  }
  if (agentsRoot) {
    totalBytes += Number(agentsRoot.bytes) || 0;
    totalFileCount += Number(agentsRoot.fileCount) || 0;
  }
  if (authFile) {
    totalBytes += Number(authFile.bytes) || 0;
  }
  if (totalBytes > OPENCODE_CONFIG_SYNC_MAX_BYTES || totalFileCount > OPENCODE_CONFIG_SYNC_MAX_FILES) {
    throw new Error('OpenCode config sync exceeds size limit (512MB)');
  }

  const full = {
    direction,
    ...(typeof options.syncRunId === 'string' && options.syncRunId ? { syncRunId: options.syncRunId } : {}),
    ...(typeof options.sourceTargetId === 'string' && options.sourceTargetId
      ? { sourceTargetId: options.sourceTargetId }
      : {}),
    ...(typeof options.targetId === 'string' && options.targetId ? { targetId: options.targetId } : {}),
    files,
    directories,
    agentsRoot,
    authFile,
    deletes,
    totalBytes,
  };
  return selections ? filterPlanBySelections(full, selections) : full;
};
