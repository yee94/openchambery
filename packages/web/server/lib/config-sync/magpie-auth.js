import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_AUTH_BYTES = 8 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const accountKey = (value) => typeof value === 'string' && /^[\w.-]+(?:#[\w.-]+)?$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const portableLogin = (row, plugins) => object(row) && typeof row.user === 'string'
  && ((row.agent === 'codex' && !row.home && object(row.auth) && object(row.auth.tokens))
    || (typeof row.agent === 'string' && row.agent.startsWith('plugin:')
      && accountKey(row.home) && Object.hasOwn(plugins, row.home)
      && row.agent === `plugin:${row.home.split('#')[0]}`));

const readStore = async (file, fallback) => {
  try {
    if ((await fs.stat(file)).size > MAX_AUTH_BYTES) throw new Error();
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Unable to read Magpie authorization store');
  }
};

export const validateMagpieAuth = (value) => {
  if (!object(value) || !object(value.plugins) || !Array.isArray(value.logins)
    || typeof value.incomplete !== 'boolean' || JSON.stringify(value).length > MAX_AUTH_BYTES
    || Object.entries(value.plugins).some(([key, auth]) => !accountKey(key) || !object(auth)
      || !['api', 'oauth'].includes(auth.type)
      || (auth.type === 'api' ? typeof auth.key !== 'string' || !auth.key
        : typeof auth.access !== 'string' || typeof auth.refresh !== 'string'))
    || value.logins.some((row) => !portableLogin(row, value.plugins))) {
    throw new Error('Invalid Magpie authorization payload');
  }
  return value;
};

export const collectMagpieAuth = async (dir, accounts) => {
  if (!Array.isArray(accounts) || accounts.some((row) => !object(row) || typeof row.agent !== 'string')) {
    throw new Error('Unable to read source Magpie accounts');
  }
  const plugins = await readStore(path.join(dir, 'plugin-auth.json'), {});
  const rows = await readStore(path.join(dir, 'logins.json'), []);
  if (!object(plugins) || !Array.isArray(rows) || rows.some((row) => !object(row))) {
    throw new Error('Invalid Magpie authorization store');
  }
  const available = new Set(accounts.map((row) => row.agent));
  const visiblePlugins = Object.fromEntries(Object.entries(plugins).filter(([key]) => available.has(key.split('#')[0])
    && !rows.some((row) => row.agent === `plugin:${key.split('#')[0]}` && row.home === key && row.hidden)));
  const logins = rows.filter((row) => !row.hidden && portableLogin(row, visiblePlugins));
  return validateMagpieAuth({ plugins: visiblePlugins, logins,
    incomplete: accounts.some((account) => !Object.keys(visiblePlugins).some((key) => key.split('#')[0] === account.agent)
      && !logins.some((row) => row.agent === account.agent && row.user === account.user)) });
};

const writeStore = async (file, value) => {
  const staging = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(staging, file);
  } finally { await fs.rm(staging, { force: true }); }
};

// Use Magpie's own lock filenames; never steal a lock from a running token refresh.
const lockStore = async (file) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await fs.open(`${file}.lock`, 'wx', 0o600);
      await handle.close();
      return () => fs.rm(`${file}.lock`, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Unable to lock Magpie authorization store');
      await delay(50);
    }
  }
  throw new Error('Magpie authorization store is busy; retry sync');
};

export const restoreMagpieAuth = async (dir, input, importCodex) => {
  const auth = validateMagpieAuth(input);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const pluginFile = path.join(dir, 'plugin-auth.json');
  const unlockPlugins = await lockStore(pluginFile);
  try {
    const plugins = await readStore(pluginFile, {});
    if (!object(plugins)) throw new Error('Invalid destination Magpie authorization store');
    await writeStore(pluginFile, { ...plugins, ...auth.plugins });
  } finally { await unlockPlugins(); }
  // Codex's native importer owns its OS-level logins lock, account deduplication and identity.
  for (const row of auth.logins) {
    if (row.agent === 'codex' && !row.hidden) await importCodex(row.auth);
  }
};

export const verifyMagpieAuth = (auth, accounts) => {
  if (!Array.isArray(accounts) || accounts.some((row) => !object(row) || typeof row.agent !== 'string')) {
    throw new Error('Unable to verify Magpie accounts');
  }
  const expected = new Map();
  for (const key of Object.keys(auth.plugins)) {
    const id = key.split('#')[0];
    expected.set(id, (expected.get(id) || 0) + 1);
  }
  const missingAccount = auth.logins.some((row) => !row.hidden
    && !accounts.some((account) => account.agent === row.agent.replace(/^plugin:/, '')
      && String(account.user).toLowerCase() === row.user.toLowerCase()));
  if (missingAccount || [...expected].some(([id, count]) => accounts.filter((row) => row.agent === id).length < count)) {
    throw new Error('Magpie authorization saved but some accounts are not recognized; check destination plugins and retry');
  }
};
