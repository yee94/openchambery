import fsp from 'node:fs/promises';
import path from 'node:path';

export const SYNC_RUN_HISTORY_LIMIT = 20;

/** @param {string} targetId */
export const syncTargetIdForSshInstance = (instanceId) => {
  const id = String(instanceId || '').trim();
  if (!id) throw new Error('SSH instance id is required');
  return `ssh:${id}`;
};

/** @param {string} hostId */
export const syncTargetIdForDirectHost = (hostId) => {
  const id = String(hostId || '').trim();
  if (!id) throw new Error('Desktop host id is required');
  return `host:${id}`;
};

/** @param {string} serverId */
export const syncTargetIdForRelayServer = (serverId) => {
  const id = String(serverId || '').trim();
  if (!id) throw new Error('Relay serverId is required');
  return `relay:${id}`;
};

/** Filename-safe encoding for targetId (Windows rejects `:` in names). */
export const syncRunFileNameForTargetId = (targetId) => `${encodeURIComponent(String(targetId || '').trim())}.jsonl`;

/**
 * Append-only sync run records under `<dataDir>/sync-runs/<encodedTargetId>.jsonl`.
 * Keeps the newest {@link SYNC_RUN_HISTORY_LIMIT} records per target.
 *
 * @param {{ dataDir: string } | { resolveDataDir: () => string }} options
 */
export const createSyncRunStore = (options) => {
  const resolveDataDir = typeof options?.resolveDataDir === 'function'
    ? options.resolveDataDir
    : () => String(options?.dataDir || '');

  const resolveFilePath = (targetId) => {
    const trimmed = String(targetId || '').trim();
    if (!trimmed) throw new Error('sync targetId is required');
    return path.join(resolveDataDir(), 'sync-runs', syncRunFileNameForTargetId(trimmed));
  };

  const readAll = async (targetId) => {
    const filePath = resolveFilePath(targetId);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && typeof entry === 'object');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  };

  /**
   * @param {string} targetId
   * @param {Record<string, unknown>} record
   */
  const append = async (targetId, record) => {
    const filePath = resolveFilePath(targetId);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readAll(targetId);
    const next = [...existing, record].slice(-SYNC_RUN_HISTORY_LIMIT);
    const body = `${next.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, filePath);
    return next;
  };

  return {
    resolveFilePath,
    readAll,
    append,
  };
};

/**
 * Build a compact summary from an OpenCode config sync plan / apply result.
 * @param {{ files?: unknown[], directories?: unknown[], deletes?: unknown[], totalBytes?: number, filesCount?: number, directoriesCount?: number, deletesCount?: number } | null | undefined} planOrResult
 */
export const summarizeSyncPlan = (planOrResult) => {
  const source = planOrResult && typeof planOrResult === 'object' ? planOrResult : {};
  const files = Array.isArray(source.files)
    ? source.files.length
    : (Number.isFinite(source.files) ? Number(source.files) : (Number.isFinite(source.filesCount) ? Number(source.filesCount) : 0));
  const directories = Array.isArray(source.directories)
    ? source.directories.length
    : (Number.isFinite(source.directories) ? Number(source.directories) : (Number.isFinite(source.directoriesCount) ? Number(source.directoriesCount) : 0));
  const deletes = Array.isArray(source.deletes)
    ? source.deletes.length
    : (Number.isFinite(source.deletes) ? Number(source.deletes) : (Number.isFinite(source.deletesCount) ? Number(source.deletesCount) : 0));
  const totalBytes = Number.isFinite(source.totalBytes) ? Number(source.totalBytes) : 0;
  return { files, directories, deletes, totalBytes };
};
