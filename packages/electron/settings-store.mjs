import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Process-local serialized settings.json store.
 * All desktop writers (main, ssh-manager, in-process web settings-runtime)
 * must share one instance so concurrent read-modify-write cannot clobber
 * sibling fields.
 *
 * @param {{ resolveFilePath: () => string } | { filePath: string }} options
 */
export const createSettingsStore = (options) => {
  const resolveFilePath = typeof options?.resolveFilePath === 'function'
    ? options.resolveFilePath
    : () => String(options?.filePath || '');

  let mutationChain = Promise.resolve();

  const readJsonFile = (filePath) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      // Parse errors can happen if a concurrent writer just truncated the file
      // and hasn't finished writing yet. Log loudly so we notice, then return
      // {} as before. Writes are atomic (tmp + rename) so this race is rare.
      console.warn?.('[settings-store] failed to read JSON file', filePath, error);
      return {};
    }
  };

  const writeJsonFile = async (filePath, data) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Atomic: write to a temp file then rename. Readers never see a partial
    // JSON file that could parse-error and get coerced to {}.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, filePath);
  };

  const readRoot = () => {
    const filePath = resolveFilePath();
    if (!filePath) return {};
    const root = readJsonFile(filePath);
    return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
  };

  /**
   * Run exclusive work on the settings mutation chain.
   * Used by Electron main/ssh writers and by the in-process web settings runtime.
   * @template T
   * @param {() => Promise<T> | T} work
   * @returns {Promise<T>}
   */
  const runExclusive = (work) => {
    const next = mutationChain.then(async () => work());
    // Keep the chain alive even if one mutator throws.
    mutationChain = next.catch(() => {});
    return next;
  };

  /**
   * Serialized read-modify-write of the settings root object.
   * @param {(root: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void} mutator
   */
  const mutate = (mutator) => runExclusive(async () => {
    const current = readRoot();
    const result = await mutator(current);
    const nextRoot = result ?? current;
    await writeJsonFile(resolveFilePath(), nextRoot);
    return nextRoot;
  });

  return {
    resolveFilePath,
    readRoot,
    mutate,
    runExclusive,
    writeJsonFile,
  };
};
