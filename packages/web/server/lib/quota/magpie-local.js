import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Read only Magpie's own address hints. A hint is never proof of a running gateway. */
export async function discoverLocalMagpie({ env = process.env, home = os.homedir(), readFile = fs.readFile, stat = fs.stat } = {}) {
  const urls = new Set();
  let incomplete = false;
  if (env.MAGPIE_ADDR) {
    try {
      const url = new URL(`http://${env.MAGPIE_ADDR}`);
      if (['0.0.0.0', '[::]'].includes(url.hostname)) url.hostname = '127.0.0.1';
      urls.add(url.href);
    } catch { incomplete = true; }
  }
  const directories = new Set([path.join(home, '.config', 'magpie')]);
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) directories.add(path.join(env.XDG_CONFIG_HOME, 'magpie'));
  for (const directory of directories) {
    try {
      if (!(await stat(directory)).isDirectory()) continue;
      let settings = {};
      try { settings = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const port = Number.isInteger(settings?.port) && settings.port >= 1024 && settings.port <= 65535 ? settings.port : 3425;
      urls.add(`http://127.0.0.1:${port}`);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') incomplete = true;
    }
  }
  return { urls: [...urls], incomplete };
}
