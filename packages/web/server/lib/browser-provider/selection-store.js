/**
 * Persists only the selected provider id. A missing file is no selection.
 * A read that fails is not "nothing selected": the caller must not overwrite
 * the file or treat the catalog as an empty success.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readBrowserProviderId } from './contract.js';

/**
 * @param {string} filePath
 */
export const createBrowserProviderSelectionStore = (filePath) => ({
  async read() {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw error;
    }
    return readBrowserProviderId(parsed?.selectedId);
  },

  async write(id) {
    const selectedId = readBrowserProviderId(id);
    if (!selectedId) {
      throw new Error('browser provider selection id is invalid');
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ selectedId })}\n`, 'utf8');
    await fs.rename(temp, filePath);
  },
});
