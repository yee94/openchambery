import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMagpieSync } from './magpie.js';
import { planOpenCodeConfigSync, planOpenCodeConfigSyncFromInventory } from './plan.js';
import { applyConfigSyncPlan } from './engine.js';

const dirs = [];
const machine = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-magpie-test-'));
  dirs.push(home);
  return { home, options: {
    homedir: () => home, tempdir: () => home, platform: 'linux', arch: 'x64',
    env: { HOME: home, PATH: '', XDG_CONFIG_HOME: path.join(home, '.config') },
  } };
};
const write = async (file, content = '{}') => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('Magpie discovery and native transfer', () => {
  it('hides config-only sources until Magpie is installed, without installing during preview', async () => {
    const { home, options } = await machine();
    const fetchImpl = vi.fn();
    const sync = createMagpieSync({ ...options, fetchImpl });
    expect(await sync.inventory()).toEqual({ available: false, installed: false });
    await write(path.join(home, '.config', 'magpie', 'providers.json'));
    expect(await sync.inventory()).toEqual({ available: false, installed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a symlinked client executable and its portable configuration', async () => {
    const { home, options } = await machine();
    const app = path.join(home, 'portable', 'magpie.app', 'Contents', 'MacOS', 'magpie');
    await write(app, 'fixture-binary');
    await write(path.join(home, 'portable', '.portable'), '');
    await write(path.join(home, 'portable', 'data', 'providers.json'));
    const link = path.join(home, 'magpie');
    await fs.symlink(app, link);
    const run = vi.fn(async () => 'magpie 0.1.0');
    const sync = createMagpieSync({ ...options, env: { ...options.env, MAGPIE_BINARY: link }, run });
    expect(await sync.inventory()).toEqual({ available: true, installed: true });
    expect(run.mock.calls[0][0]).toBe(await fs.realpath(app));
  });

  it('exports noninteractively, installs a verified destination CLI and cleans temporary files', async () => {
    const source = await machine();
    const target = await machine();
    const binary = path.join(source.home, '.local', 'bin', 'magpie');
    await write(binary, 'fixture-cli');
    await write(path.join(source.home, '.config', 'magpie', 'providers.json'));
    const runSource = vi.fn(async (_binary, args, ctx) => {
      if (args[0] === '--version') return 'magpie 0.1.0';
      if (args[0] === 'accounts') return '[]';
      expect(args[0]).toBe('backup');
      expect(ctx.input).toMatch(/^[a-f0-9]{64}\n$/);
      expect(args).not.toContain(ctx.input.trim());
      await write(args[1], JSON.stringify({ format: 'magpie-backup', data: 'fixture-encrypted' }));
      return 'saved';
    });
    const payload = await createMagpieSync({ ...source.options, run: runSource }).download();
    const bytes = Buffer.from('fixture-installed-cli');
    const fetchImpl = vi.fn(async (url) => url === 'https://usemagpie.ai/api/latest'
      ? Response.json({ assets: { 'magpie-cli-linux-amd64': {
        url: 'https://github.com/yetone/magpie-releases/releases/download/v0.1.0/magpie-cli-linux-amd64',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } } }) : new Response(bytes));
    const runTarget = vi.fn(async (_binary, args, ctx) => {
      if (args[0] === '--version') return 'magpie 0.1.0';
      if (args[0] === 'accounts') return '[]';
      expect(args[0]).toBe('restore');
      expect(ctx.input.trim()).toBe(JSON.parse(payload).passphrase);
      expect(JSON.parse(await fs.readFile(args[1], 'utf8')).format).toBe('magpie-backup');
      await write(path.join(target.home, '.config', 'magpie', 'providers.json'), '{"providers":[]}');
      return 'restored';
    });
    const destination = createMagpieSync({ ...target.options, fetchImpl, run: runTarget });
    await expect(destination.import(payload)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await fs.realpath(path.join(target.home, '.local/bin/magpie'))).toBe(await fs.realpath(path.join(target.home, '.config/yuri/tools/magpie/magpie')));
    await expect(destination.import(payload)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const item of [source, target]) {
      expect((await fs.readdir(item.home)).filter((name) => name.startsWith('yuri-magpie-'))).toEqual([]);
    }
  });

  it('repairs a previously managed installation without downloading or overwriting a user command', async () => {
    const { home, options } = await machine();
    const managed = path.join(home, '.config/yuri/tools/magpie/magpie');
    const entry = path.join(home, '.local/bin/magpie');
    const fetchImpl = vi.fn();
    const run = vi.fn(async () => 'magpie 0.1.1319');
    const sync = createMagpieSync({ ...options, fetchImpl, run });
    await sync.repairInstallation();
    expect(run).not.toHaveBeenCalled();
    await write(managed, 'fixture');
    await sync.repairInstallation();
    await sync.repairInstallation();
    expect(await fs.realpath(entry)).toBe(await fs.realpath(managed));
    await fs.unlink(entry);
    await write(entry, 'user installation');
    await sync.repairInstallation();
    expect(await fs.readFile(entry, 'utf8')).toBe('user installation');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('round-trips plugin accounts and Codex through v2 and verifies the final account inventory', async () => {
    const source = await machine();
    const target = await machine();
    for (const item of [source, target]) await write(path.join(item.home, '.local/bin/magpie'), 'fixture');
    const sourceDir = path.join(source.home, '.config/magpie');
    const targetDir = path.join(target.home, '.config/magpie');
    await write(path.join(sourceDir, 'providers.json'), '{"providers":[{"id":"astra"},{"id":"codex"}]}');
    await write(path.join(sourceDir, 'plugin-auth.json'), JSON.stringify({ 'astra#one': { type: 'api', key: 'fixture-key' } }));
    await write(path.join(sourceDir, 'logins.json'), JSON.stringify([
      { agent: 'codex', user: 'fixture@example.invalid', auth: { tokens: { access_token: 'fixture-token' } } },
    ]));
    const payload = await createMagpieSync({ ...source.options, run: async (_binary, args) => {
      if (args[0] === '--version') return 'magpie 0.1.1319';
      if (args[0] === 'accounts') return '[{"agent":"astra"},{"agent":"codex","user":"fixture@example.invalid"}]';
      await write(args[1], '{"format":"magpie-backup"}');
      return '';
    } }).download();
    expect(JSON.parse(payload).format).toBe('magpie-sync-v2');
    await write(path.join(targetDir, 'plugin-auth.json'), '{"destination-only":{"type":"api","key":"keep"}}');
    let recognized = true;
    const run = vi.fn(async (_binary, args) => {
      if (args[0] === '--version') return 'magpie 0.1.1319';
      if (args[0] === 'restore') {
        await write(path.join(targetDir, 'providers.json'), await fs.readFile(path.join(sourceDir, 'providers.json')));
        return 'not signed in on this computer';
      }
      if (args[1] === 'import') {
        expect(args).not.toContain('fixture-token');
        expect(JSON.parse(await fs.readFile(args[3], 'utf8')).tokens.access_token).toBe('fixture-token');
        expect((await fs.stat(args[3])).mode & 0o777).toBe(0o600);
        return '';
      }
      return JSON.stringify(recognized ? [{ agent: 'astra' }, { agent: 'codex', user: 'fixture@example.invalid' }] : []);
    });
    const sync = createMagpieSync({ ...target.options, run });
    await expect(sync.import(payload)).resolves.toEqual({ ok: true });
    await expect(sync.import(payload)).resolves.toEqual({ ok: true });
    const stored = JSON.parse(await fs.readFile(path.join(targetDir, 'plugin-auth.json'), 'utf8'));
    expect(Object.keys(stored)).toEqual(['destination-only', 'astra#one']);
    recognized = false;
    await expect(sync.import(payload)).rejects.toThrow('authorization sync or verification failed');
    expect((await fs.readdir(target.home)).filter((name) => name.startsWith('yuri-magpie-'))).toEqual([]);
  });

  it('rejects malformed v2 authorization before installing or restoring', async () => {
    const { options } = await machine();
    const run = vi.fn();
    const fetchImpl = vi.fn();
    const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v2', passphrase: 'a'.repeat(64),
      backup: Buffer.from('{"format":"magpie-backup"}').toString('base64'),
      authorization: { plugins: {}, logins: [{ agent: 'codex', home: '/source/path', auth: {} }], incomplete: false } }));
    await expect(createMagpieSync({ ...options, run, fetchImpl }).import(payload)).rejects.toThrow('Invalid Magpie sync payload');
    expect(run).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries agent settings after authorizations instead of keeping a pre-login skip warning', async () => {
    const { home, options } = await machine();
    await write(path.join(home, '.local/bin/magpie'), 'fixture');
    let restores = 0;
    const run = async (_binary, args) => {
      if (args[0] === '--version') return 'magpie 0.1.1319';
      if (args[0] === 'accounts') return '[]';
      return ++restores === 1 ? 'Left as they are' : 'restored';
    };
    const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v2', passphrase: 'a'.repeat(64),
      backup: Buffer.from('{"format":"magpie-backup"}').toString('base64'),
      authorization: { plugins: {}, logins: [], incomplete: false } }));
    await expect(createMagpieSync({ ...options, run }).import(payload)).resolves.toEqual({ ok: true });
    expect(restores).toBe(2);
  });

  it('does not install on malformed payload and refuses partial restore without leaking CLI output', async () => {
    const { home, options } = await machine();
    const fetchImpl = vi.fn();
    const run = vi.fn(async (_binary, args) => args[0] === '--version'
      ? 'magpie 0.1.0' : "Couldn't add the plugin private-fixture-value");
    const sync = createMagpieSync({ ...options, fetchImpl, run });
    await expect(sync.import(Buffer.from('{}'))).rejects.toThrow('Invalid Magpie sync payload');
    expect(fetchImpl).not.toHaveBeenCalled();
    await write(path.join(home, '.local', 'bin', 'magpie'), 'fixture-cli');
    const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v1', passphrase: 'a'.repeat(64),
      backup: Buffer.from('{"format":"magpie-backup"}').toString('base64') }));
    await expect(sync.import(payload)).rejects.toThrow('Magpie restore partially completed');
    expect((await fs.readdir(home)).filter((name) => name.startsWith('yuri-magpie-'))).toEqual([]);
  });

  it('reports excluded sign-ins as a warning after a successful native restore', async () => {
    const { home, options } = await machine();
    await write(path.join(home, '.local', 'bin', 'magpie'), 'fixture-cli');
    const run = async (_binary, args) => args[0] === '--version' ? 'magpie 0.1.1319'
      : "restored providers: 0 added, 8 replaced\nThe backup's settings use these, not signed in on this computer (a backup carries settings, not sign-ins; to use one here: magpie accounts add <id>): private-fixture-account\n";
    const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v1', passphrase: 'a'.repeat(64),
      backup: Buffer.from('{"format":"magpie-backup"}').toString('base64') }));
    await expect(createMagpieSync({ ...options, run }).import(payload)).resolves.toEqual({
      ok: true, magpieWarnings: ['sign_in_required'],
    });
  });

  it('requires current source discovery and supports a Magpie-only plan', async () => {
    const { home } = await machine();
    const selections = { fileGroups: [], singleFiles: [], directories: [], agentsRoot: false, providerCredentials: false, magpie: true };
    expect(() => planOpenCodeConfigSync(home, { selections })).toThrow('unavailable');
    const plan = planOpenCodeConfigSync(home, { selections, magpie: { available: true, installed: true } });
    expect(plan.magpie).toEqual({ bytes: 0 });
    const received = [];
    const executor = { prepare: vi.fn(), putTar: async (value) => received.push(value), finalize: vi.fn(async () => ({ magpieWarnings: ['sign_in_required'] })) };
    const result = await applyConfigSyncPlan({ plan, executor, syncRunId: 'test', sourceHomedir: home, collectMagpie: async () => Buffer.from('fixture') });
    expect(result.magpieWarnings).toEqual(['sign_in_required']);
    expect(received).toEqual([{ kind: 'magpie', payload: Buffer.from('fixture') }]);
    received.length = 0;
    await applyConfigSyncPlan({ plan: { ...plan, files: [{ path: 'opencode.json' }] }, executor, syncRunId: 'ordered', sourceHomedir: home,
      collectTar: async () => Buffer.from('config'), collectMagpie: async () => Buffer.from('fixture') });
    expect(received.map((entry) => entry.kind)).toEqual(['magpie', 'config']);
    const pull = planOpenCodeConfigSyncFromInventory({ files: [], directories: [], magpie: { available: true } }, { selections });
    expect(pull.magpieAvailable).toBe(true);
    expect(pull.magpie).toEqual({ bytes: 0 });
  });

  it('rejects a corrupt installer before executing or publishing it', async () => {
    const { home, options } = await machine();
    const run = vi.fn();
    const fetchImpl = async (url) => url === 'https://usemagpie.ai/api/latest'
      ? Response.json({ assets: { 'magpie-cli-linux-amd64': {
        url: 'https://github.com/yetone/magpie-releases/releases/download/v0.1.0/magpie-cli-linux-amd64',
        sha256: '0'.repeat(64),
      } } }) : new Response('corrupt');
    const sync = createMagpieSync({ ...options, fetchImpl, run });
    const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v1', passphrase: 'a'.repeat(64),
      backup: Buffer.from('{"format":"magpie-backup"}').toString('base64') }));
    await expect(sync.import(payload)).rejects.toThrow('checksum mismatch');
    expect(run).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(home, '.config', 'yuri', 'tools', 'magpie', 'magpie'))).rejects.toThrow();
  });

  it.skipIf(!process.env.YURI_MAGPIE_TEST_BINARY)('round-trips isolated configuration with the installed real CLI', async () => {
    const source = await machine();
    const target = await machine();
    for (const item of [source, target]) {
      item.options.env = { ...item.options.env, MAGPIE_BINARY: process.env.YURI_MAGPIE_TEST_BINARY,
        MAGPIE_NO_ACCOUNTS: '1', PATH: '/usr/bin:/bin', XDG_CACHE_HOME: path.join(item.home, '.cache') };
      await write(path.join(item.home, '.config', 'magpie', 'settings.json'), JSON.stringify({ noAccountDiscovery: true, noStats: true, noUsageStats: true, noAutoUpdate: true }));
    }
    await write(path.join(source.home, '.config', 'magpie', 'providers.json'), JSON.stringify({ providers: [
      { id: 'sync-fixture', name: 'Sync fixture', chat: 'https://provider.invalid/v1', key: 'fixture-not-a-real-key' },
      { id: 'fixture-subscription' },
    ] }));
    const payload = await createMagpieSync(source.options).download();
    const receipt = await createMagpieSync(target.options).import(payload);
    expect(receipt).toEqual({ ok: true, magpieWarnings: ['sign_in_required'] });
    const restored = JSON.parse(await fs.readFile(path.join(target.home, '.config', 'magpie', 'providers.json'), 'utf8'));
    expect(restored.providers).toContainEqual(expect.objectContaining({ id: 'sync-fixture', key: 'fixture-not-a-real-key' }));
  }, 60_000);
});
