import { createHash } from 'node:crypto';

const MAX_BYTES = 32 * 1024 * 1024;
const versionOf = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Called only after the owning route has authorized and canonicalized the path. */
export const createImageFingerprintReader = (fs) => {
  const entries = new Map();
  let tail = Promise.resolve();
  return async (file) => {
    const before = await fs.stat(file, { bigint: true });
    if (!before.isFile() || before.size < 0 || before.size > MAX_BYTES) throw new Error('Invalid file fingerprint size');
    const version = versionOf(before);
    const previous = entries.get(file);
    if (previous?.version === version) return previous.promise;
    const promise = tail.then(async () => {
      const handle = await fs.open(file, 'r');
      try {
        if (versionOf(await handle.stat({ bigint: true })) !== version) throw new Error('Image changed during fingerprint read');
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > MAX_BYTES) throw new Error('Image exceeds fingerprint limit');
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await fs.stat(file, { bigint: true });
        if (versionOf(after) !== version || total !== Number(before.size)) throw new Error('Image changed during fingerprint read');
        return hash.digest('hex');
      } finally { await handle.close(); }
    });
    tail = promise.then(() => undefined, () => undefined);
    const entry = { version, promise };
    entries.delete(file);
    entries.set(file, entry);
    while (entries.size > 128) entries.delete(entries.keys().next().value);
    try { return await promise; }
    catch (error) { if (entries.get(file) === entry) entries.delete(file); throw error; }
  };
};
