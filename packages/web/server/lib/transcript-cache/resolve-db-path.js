import path from 'node:path';

const FORBIDDEN_TRANSCRIPT_CACHE_BASENAMES = new Set([
  'session-index.sqlite',
  'message-queue.sqlite',
]);

/**
 * Normalize an explicit cache path. Only `.sqlite` files are accepted; the
 * managed session-index and message-queue basenames are rejected.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
const normalizeTranscriptCacheDbPath = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  if (path.extname(resolved).toLowerCase() !== '.sqlite') return null;
  if (FORBIDDEN_TRANSCRIPT_CACHE_BASENAMES.has(path.basename(resolved).toLowerCase())) {
    return null;
  }
  return resolved;
};

/**
 * Resolves the transcript-cache SQLite path.
 *
 * Default is null: ordinary remote Web servers must not persist conversation
 * bodies. Only an explicit `transcriptCacheDbPath` or
 * `OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH` enables the local acceleration cache.
 *
 * @param {object} [options]
 * @param {string|null|undefined} options.transcriptCacheDbPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export const resolveTranscriptCacheDbPath = ({ transcriptCacheDbPath } = {}, env = process.env) => {
  if (transcriptCacheDbPath === null) return null;
  if (typeof transcriptCacheDbPath === 'string' && transcriptCacheDbPath.trim()) {
    return normalizeTranscriptCacheDbPath(transcriptCacheDbPath);
  }
  const fromEnv = env?.OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return normalizeTranscriptCacheDbPath(fromEnv);
  return null;
};
