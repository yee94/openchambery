import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  OPENCODE_AGENTS_ROOT_PROBE_MARKER,
  OPENCODE_AUTH_FILE_PROBE_MARKER,
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_MAX_BYTES,
  OPENCODE_CONFIG_SYNC_MAX_FILES,
} from './constants.js';
import {
  extractTarGzBuffer,
  finalizeLocalSyncDestination,
  prepareLocalSyncDestination,
} from './local-backup.js';
import { walkAllowlistDirectory } from './plan.js';
import { sanitizeSyncRunIdForPath } from './scripts.js';

/**
 * In-process receiver for HTTP config-sync (direct/relay hosts).
 * One inflight sync at a time; backups use the same local generational helpers as pull.
 */
export const createConfigSyncReceiver = (deps = {}) => {
  const {
    homedir = () => os.homedir(),
  } = deps;

  let inflight = null;

  const beginInflight = (syncRunId) => {
    const id = sanitizeSyncRunIdForPath(syncRunId);
    if (inflight) {
      const error = new Error(`Config sync already in progress (${inflight.syncRunId})`);
      error.code = 'sync_in_progress';
      error.syncRunId = inflight.syncRunId;
      throw error;
    }
    inflight = { syncRunId: id, startedAt: Date.now(), prepared: false, kinds: new Set() };
    return inflight;
  };

  const requireInflight = (syncRunId) => {
    const id = sanitizeSyncRunIdForPath(syncRunId);
    if (!inflight || inflight.syncRunId !== id) {
      const error = new Error('No matching in-flight config sync');
      error.code = 'sync_not_prepared';
      throw error;
    }
    return inflight;
  };

  const clearInflight = (syncRunId) => {
    if (inflight && inflight.syncRunId === sanitizeSyncRunIdForPath(syncRunId)) {
      inflight = null;
    }
  };

  const buildInventory = () => {
    const home = homedir();
    const root = path.join(home, '.config', 'opencode');
    const files = [];
    const directories = [];
    const remoteExisting = [];

    for (const group of OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups) {
      for (const member of group) {
        const abs = path.join(root, member);
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          files.push({ path: member, bytes: st.size });
          remoteExisting.push(member);
          break;
        } catch {
          // missing
        }
      }
    }
    for (const name of OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles) {
      const abs = path.join(root, name);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        files.push({ path: name, bytes: st.size });
        remoteExisting.push(name);
      } catch {
        // missing
      }
    }
    for (const dirSpec of OPENCODE_CONFIG_SYNC_ALLOWLIST.directories) {
      const abs = path.join(root, dirSpec.path);
      try {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) continue;
        const excludeNames = new Set(Array.isArray(dirSpec.excludeNames) ? dirSpec.excludeNames : []);
        const walked = walkAllowlistDirectory(abs, excludeNames, new Set());
        directories.push({ path: dirSpec.path, fileCount: walked.fileCount, bytes: walked.bytes });
        remoteExisting.push(dirSpec.path);
      } catch {
        // missing
      }
    }

    let agentsRoot = null;
    let remoteAgentsRootExists = false;
    try {
      const agentsAbs = path.join(home, '.agents');
      const st = fs.statSync(agentsAbs);
      if (st.isDirectory()) {
        remoteAgentsRootExists = true;
        const walked = walkAllowlistDirectory(agentsAbs, new Set(), new Set());
        agentsRoot = { fileCount: walked.fileCount, bytes: walked.bytes };
      }
    } catch {
      // missing
    }

    let authFile = null;
    let remoteAuthFileExists = false;
    try {
      const authAbs = path.join(home, '.local', 'share', 'opencode', 'auth.json');
      const st = fs.statSync(authAbs);
      if (st.isFile()) {
        remoteAuthFileExists = true;
        authFile = { bytes: st.size };
      }
    } catch {
      // missing
    }

    return {
      inventory: { files, directories, agentsRoot, authFile },
      remoteExisting,
      remoteAgentsRootExists,
      remoteAuthFileExists,
      markers: {
        agentsRoot: OPENCODE_AGENTS_ROOT_PROBE_MARKER,
        authFile: OPENCODE_AUTH_FILE_PROBE_MARKER,
      },
    };
  };

  const probe = async (plan) => {
    const snapshot = buildInventory();
    const existing = new Set(snapshot.remoteExisting);
    const planPaths = [
      ...(Array.isArray(plan?.files) ? plan.files.map((entry) => entry.path) : []),
      ...(Array.isArray(plan?.directories) ? plan.directories.map((entry) => entry.path) : []),
      ...(Array.isArray(plan?.deletes) ? plan.deletes : []),
    ];
    return {
      ...snapshot,
      remoteExisting: [...new Set(planPaths.filter((rel) => existing.has(rel)))],
    };
  };

  const prepare = async (plan, { syncRunId }) => {
    const flight = beginInflight(syncRunId);
    try {
      await prepareLocalSyncDestination(homedir(), plan, { syncRunId: flight.syncRunId });
      flight.prepared = true;
      flight.plan = plan;
      return { ok: true, syncRunId: flight.syncRunId, ready: true };
    } catch (error) {
      clearInflight(syncRunId);
      throw error;
    }
  };

  const readStreamToBuffer = async (stream, { maxBytes }) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        const error = new Error(`Config sync payload exceeds size limit (${maxBytes} bytes)`);
        error.code = 'sync_payload_too_large';
        throw error;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  };

  const put = async ({ syncRunId, kind, stream }) => {
    const flight = requireInflight(syncRunId);
    if (!flight.prepared) {
      const error = new Error('Config sync prepare must complete before put');
      error.code = 'sync_not_prepared';
      throw error;
    }
    const buffer = await readStreamToBuffer(stream, { maxBytes: OPENCODE_CONFIG_SYNC_MAX_BYTES });
    const home = homedir();
    if (kind === 'config') {
      await extractTarGzBuffer(buffer, path.join(home, '.config', 'opencode'));
    } else if (kind === 'agents') {
      await extractTarGzBuffer(buffer, home);
    } else if (kind === 'auth') {
      await fsp.mkdir(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
      await extractTarGzBuffer(buffer, path.join(home, '.local', 'share', 'opencode'));
    } else {
      const error = new Error(`Unsupported put kind: ${String(kind)}`);
      error.code = 'sync_invalid_kind';
      throw error;
    }
    flight.kinds.add(kind);
    return { ok: true, kind, bytes: buffer.byteLength };
  };

  const collectTarGz = (cwd, entries) => new Promise((resolve, reject) => {
    if (!entries.length) {
      resolve(Buffer.alloc(0));
      return;
    }
    const child = spawn('tar', ['-h', '-czf', '-', '-C', cwd, ...entries], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
    const chunks = [];
    let stderr = '';
    child.stdout?.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || 'Local tar failed').trim()));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });

  const download = async ({ kind }) => {
    const home = homedir();
    if (kind === 'config') {
      const snapshot = buildInventory();
      const entries = [
        ...snapshot.inventory.files.map((entry) => entry.path),
        ...snapshot.inventory.directories.map((entry) => entry.path),
      ];
      if (entries.length > OPENCODE_CONFIG_SYNC_MAX_FILES) {
        const error = new Error('Config sync exceeds file count limit');
        error.code = 'sync_too_many_files';
        throw error;
      }
      return collectTarGz(path.join(home, '.config', 'opencode'), entries);
    }
    if (kind === 'agents') {
      return collectTarGz(home, ['.agents']);
    }
    if (kind === 'auth') {
      return collectTarGz(path.join(home, '.local', 'share', 'opencode'), ['auth.json']);
    }
    const error = new Error(`Unsupported download kind: ${String(kind)}`);
    error.code = 'sync_invalid_kind';
    throw error;
  };

  const finalize = async ({ syncRunId }) => {
    const flight = requireInflight(syncRunId);
    await finalizeLocalSyncDestination(homedir(), { syncRunId: flight.syncRunId });
    const receipt = {
      ok: true,
      syncRunId: flight.syncRunId,
      kinds: [...flight.kinds],
      endedAt: new Date().toISOString(),
    };
    clearInflight(syncRunId);
    return receipt;
  };

  const abort = ({ syncRunId } = {}) => {
    if (!syncRunId) {
      inflight = null;
      return { ok: true };
    }
    clearInflight(syncRunId);
    return { ok: true };
  };

  return {
    probe,
    prepare,
    put,
    download,
    finalize,
    abort,
    getInflight: () => inflight,
    buildInventory,
  };
};
