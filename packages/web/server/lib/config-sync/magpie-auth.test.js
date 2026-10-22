import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectMagpieAuth, restoreMagpieAuth, validateMagpieAuth, verifyMagpieAuth } from './magpie-auth.js';

const dirs = [];
const directory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-auth-test-'));
  dirs.push(dir);
  return dir;
};
const auth = { plugins: { 'cursor#one': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 123 } }, logins: [], incomplete: false };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('Magpie authorization transfer', () => {
  it('exports recognized plugin accounts, excludes hidden/stale accounts and flags unsupported subscriptions', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'plugin-auth.json'), JSON.stringify({ ...auth.plugins,
      stale: { type: 'api', key: 'fixture' }, 'cursor#hidden': { type: 'api', key: 'fixture' } }));
    await fs.writeFile(path.join(dir, 'logins.json'), JSON.stringify([
      { agent: 'plugin:cursor', user: 'hidden', home: 'cursor#hidden', hidden: 'mark' },
      { agent: 'chatgpt-api', user: 'fixture', auth: { clientId: 'machine-specific' } },
    ]));
    const result = await collectMagpieAuth(dir, [{ agent: 'cursor' }, { agent: 'chatgpt-api', user: 'fixture' }]);
    expect(result.plugins).toEqual(auth.plugins);
    expect(result.logins).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('does not turn corrupted stores into successful empty credentials', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'plugin-auth.json'), '{broken');
    await expect(collectMagpieAuth(dir, [])).rejects.toThrow('authorization store');
    await expect(restoreMagpieAuth(dir, auth, vi.fn())).rejects.toThrow('authorization store');
    expect(await fs.readFile(path.join(dir, 'plugin-auth.json'), 'utf8')).toBe('{broken');
    expect(await fs.readdir(dir)).toEqual(['plugin-auth.json']);
  });

  it('merges repeated imports without deleting unrelated accounts and releases the plugin lock before native imports', async () => {
    const dir = await directory();
    await fs.writeFile(path.join(dir, 'plugin-auth.json'), '{"other":{"type":"api","key":"keep"}}');
    const input = { ...auth, logins: [{ agent: 'codex', user: 'fixture', auth: { tokens: {} } }] };
    const importCodex = vi.fn(async () => {
      await expect(fs.stat(path.join(dir, 'plugin-auth.json.lock'))).rejects.toThrow();
    });
    await restoreMagpieAuth(dir, input, importCodex);
    await restoreMagpieAuth(dir, input, importCodex);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'plugin-auth.json'), 'utf8'))).toEqual({ other: { type: 'api', key: 'keep' }, ...auth.plugins });
    expect((await fs.stat(path.join(dir, 'plugin-auth.json'))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['plugin-auth.json']);
  });

  it('keeps successful plugin writes when a native import fails, so retry can finish', async () => {
    const dir = await directory();
    await expect(restoreMagpieAuth(dir, { ...auth, logins: [{ agent: 'codex', user: 'fixture', auth: { tokens: {} } }] },
      async () => { throw new Error('fixture failure'); })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(dir, 'plugin-auth.json'), 'utf8'))).toEqual(auth.plugins);
    expect(await fs.readdir(dir)).toEqual(['plugin-auth.json']);
  });

  it('preserves the previous store and cleans staging files when atomic publication fails', async () => {
    const dir = await directory();
    const file = path.join(dir, 'plugin-auth.json');
    await fs.writeFile(file, '{"other":{"type":"api","key":"keep"}}');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fixture rename failure'));
    await expect(restoreMagpieAuth(dir, auth, vi.fn())).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ other: { type: 'api', key: 'keep' } });
    expect(await fs.readdir(dir)).toEqual(['plugin-auth.json']);
  });

  it('rejects unsafe shapes and verifies every expected account rather than one account per provider', () => {
    expect(() => validateMagpieAuth({ ...auth, plugins: { '../path': { type: 'api', key: 'fixture' } } })).toThrow();
    const two = { ...auth, plugins: { ...auth.plugins, 'cursor#two': auth.plugins['cursor#one'] } };
    expect(() => verifyMagpieAuth(two, [{ agent: 'cursor' }])).toThrow('not recognized');
    expect(() => verifyMagpieAuth(two, [{ agent: 'cursor' }, { agent: 'cursor' }])).not.toThrow();
    expect(() => verifyMagpieAuth(auth, {})).toThrow('verify');
  });
});
