import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { collectMagpieAuth, restoreMagpieAuth, validateMagpieAuth, verifyMagpieAuth } from './magpie-auth.js';

const MAX_BYTES = 64 * 1024 * 1024;
const CONFIG_FILES = ['providers.json', 'settings.json', 'profiles.json', 'library.json', 'plugins.json', 'plugin-auth.json', 'logins.json'];
const exists = async (file) => {
  try { return await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
};

// Magpie plugins may print diagnostics on stderr while accounts --json still exits 0.
// runCli merges streams for restore pattern matching, so recover the top-level JSON array.
export const parseMagpieAccountsJson = (raw) => {
  const text = String(raw || '').replace(/\x1b\[[0-9;]*m/g, '');
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && (i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r')) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error('Unable to read Magpie accounts');
  try {
    const accounts = JSON.parse(text.slice(start));
    if (!Array.isArray(accounts)) throw new Error();
    return accounts;
  } catch {
    throw new Error('Unable to read Magpie accounts');
  }
};

// Raw CLI output may contain provider names, paths or credentials. Never forward it.
const runCli = (binary, args, { input = '', env, timeout = 600_000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let exceeded = false;
  const stop = () => {
    exceeded = true;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(stop, timeout);
  const collect = (chunk) => {
    if (output.length + chunk.length > 1024 * 1024) { stop(); return; }
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.stdin.on('error', () => {});
  child.on('error', () => { clearTimeout(timer); reject(new Error('Unable to start Magpie CLI')); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 || exceeded) reject(new Error('Magpie CLI operation failed or timed out'));
    else resolve(output.replace(/\x1b\[[0-9;]*m/g, ''));
  });
  child.stdin.end(input);
});

/** Host-owned discovery and native backup/restore. No renderer-supplied paths or commands. */
export function createMagpieSync({
  homedir = os.homedir,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  run = runCli,
  tempdir = os.tmpdir,
} = {}) {
  let installing = null;
  let busy = false;
  const home = () => homedir();
  const configDir = () => path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(home(), '.config'), 'magpie');
  const managedBinary = () => path.join(env.YURI_DATA_DIR || path.join(home(), '.config', 'yuri'),
    'tools', 'magpie', platform === 'win32' ? 'magpie.exe' : 'magpie');
  const hasConfig = async (dir) => {
    for (const file of CONFIG_FILES) if ((await exists(path.join(dir, file)))?.isFile()) return true;
    return false;
  };

  const locate = async () => {
    const name = platform === 'win32' ? 'magpie.exe' : 'magpie';
    const candidates = [
      env.MAGPIE_BINARY,
      ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
      path.join(home(), '.local', 'bin', name),
      ...(platform === 'darwin' ? [
        '/Applications/magpie.app/Contents/MacOS/magpie',
        path.join(home(), 'Applications', 'magpie.app', 'Contents', 'MacOS', 'magpie'),
        '/opt/homebrew/bin/magpie', '/usr/local/bin/magpie',
      ] : []),
      ...(platform === 'win32' && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs', 'magpie', name)] : []),
      managedBinary(),
    ].filter(Boolean);
    for (const candidate of new Set(candidates)) {
      if (!(await exists(candidate))?.isFile()) continue;
      const binary = await fs.realpath(candidate);
      const version = await run(binary, ['--version'], { env, timeout: 10_000 });
      if (!/^magpie\s+\S+/m.test(version)) throw new Error('Invalid Magpie executable');
      return binary;
    }
    return null;
  };

  const dataDir = async (binary) => {
    if (!binary) return configDir();
    let beside = path.dirname(binary);
    if (path.basename(beside) === 'MacOS' && path.basename(path.dirname(beside)) === 'Contents') {
      beside = path.dirname(path.dirname(path.dirname(beside)));
    } else if (platform === 'linux' && env.APPIMAGE && env.APPDIR
      && binary.startsWith(`${env.APPDIR}${path.sep}`)) beside = path.dirname(env.APPIMAGE);
    const portable = path.join(beside, 'data');
    if (await exists(path.join(beside, '.portable'))) return portable;
    if (!(await exists(portable))?.isDirectory()) return configDir();
    const shared = [home(), '/Applications', ...['Applications', 'Downloads', 'Desktop', 'Documents'].map((dir) => path.join(home(), dir))];
    if (!shared.some((dir) => dir.toLowerCase() === beside.toLowerCase())) return portable;
    return await hasConfig(portable) && !await hasConfig(configDir()) ? portable : configDir();
  };

  const inventory = async () => {
    const binary = await locate();
    return { available: Boolean(binary) && await hasConfig(await dataDir(binary)), installed: Boolean(binary) };
  };

  const downloadBytes = async (url, limit) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error('Unable to download Magpie CLI');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Magpie download exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  const publishExecutable = async (binary) => {
    const entry = path.join(home(), '.local', 'bin', platform === 'win32' ? 'magpie.exe' : 'magpie');
    if (await exists(entry)) {
      if (await fs.realpath(entry) === binary) return binary;
      const version = await run(entry, ['--version'], { env, timeout: 10_000 });
      if (!/^magpie\s+\S+/m.test(version)) throw new Error('Magpie command conflicts with an existing executable');
      if (await dataDir(await fs.realpath(entry)) !== await dataDir(binary)) {
        throw new Error('Magpie command uses a different portable configuration; resolve the command conflict before syncing');
      }
      return binary;
    }
    await fs.mkdir(path.dirname(entry), { recursive: true });
    try {
      if (platform === 'win32' && await dataDir(binary) === configDir()) await fs.link(binary, entry);
      else await fs.symlink(binary, entry, 'file');
    } catch (error) {
      if (error.code !== 'EEXIST' || !await exists(entry)) throw new Error('Unable to publish Magpie command for plugins');
    }
    return binary;
  };

  const repairInstallation = async () => {
    const binary = managedBinary();
    if (!(await exists(binary))?.isFile()) return;
    const version = await run(binary, ['--version'], { env, timeout: 10_000 });
    if (!/^magpie\s+\S+/m.test(version)) throw new Error('Invalid managed Magpie executable');
    await publishExecutable(await fs.realpath(binary));
  };

  const ensure = async () => {
    const binary = await locate();
    if (binary) return publishExecutable(binary);
    if (installing) return installing;
    installing = (async () => {
      const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
      if (!cpu || !['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Magpie CLI is not available for this platform');
      const assetName = `magpie-cli-${platform === 'win32' ? 'windows' : platform}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
      let feed;
      try { feed = JSON.parse((await downloadBytes('https://usemagpie.ai/api/latest', 2 * 1024 * 1024)).toString()); }
      catch { throw new Error('Unable to read Magpie release metadata'); }
      const asset = feed.assets?.[assetName];
      if (!asset || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')
        || typeof asset.url !== 'string' || !asset.url.startsWith('https://github.com/yetone/magpie-releases/releases/download/')) {
        throw new Error('No verified Magpie CLI release for this platform');
      }
      const bytes = await downloadBytes(asset.url, 256 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()) throw new Error('Magpie CLI checksum mismatch');
      const target = managedBinary();
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const staging = `${target}.${randomBytes(8).toString('hex')}${platform === 'win32' ? '.exe' : ''}`;
      try {
        await fs.writeFile(staging, bytes, { mode: 0o700, flag: 'wx' });
        const version = await run(staging, ['--version'], { env, timeout: 10_000 });
        if (!/^magpie\s+\S+/m.test(version)) throw new Error('Invalid downloaded Magpie CLI');
        await fs.rename(staging, target);
      } finally { await fs.rm(staging, { force: true }); }
      return publishExecutable(target);
    })();
    try { return await installing; }
    finally { installing = null; }
  };

  const exclusive = async (work) => {
    if (busy) throw new Error('Magpie sync already in progress');
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
  const withTemp = async (work) => {
    const dir = await fs.mkdtemp(path.join(tempdir(), 'yuri-magpie-'));
    try { return await work(path.join(dir, 'setup.magpie-backup')); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  };

  return {
    inventory,
    repairInstallation,
    download: () => exclusive(async () => {
      if (!(await inventory()).available) throw new Error('No Magpie configuration found on source');
      const binary = await ensure();
      const passphrase = randomBytes(32).toString('hex');
      return withTemp(async (file) => {
        await run(binary, ['backup', file], { env, input: `${passphrase}\n` });
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES) throw new Error('Magpie backup exceeds size limit');
        const backup = await fs.readFile(file);
        let authorization;
        try {
          const accounts = parseMagpieAccountsJson(await run(binary, ['accounts', '--json'], { env }));
          authorization = await collectMagpieAuth(await dataDir(binary), accounts);
        } catch { throw new Error('Unable to export Magpie authorizations'); }
        const payload = Buffer.from(JSON.stringify({ format: 'magpie-sync-v2', passphrase, backup: backup.toString('base64'), authorization }));
        if (payload.length > MAX_BYTES * 2) throw new Error('Magpie sync exceeds size limit');
        return payload;
      });
    }),
    import: (payload) => exclusive(async () => {
      let decoded;
      let backup;
      try {
        if (payload.length > MAX_BYTES * 2) throw new Error();
        decoded = JSON.parse(Buffer.from(payload).toString());
        if (!['magpie-sync-v1', 'magpie-sync-v2'].includes(decoded.format) || !/^[a-f0-9]{64}$/.test(decoded.passphrase)
          || typeof decoded.backup !== 'string') throw new Error();
        if (decoded.format === 'magpie-sync-v2') validateMagpieAuth(decoded.authorization);
        backup = Buffer.from(decoded.backup, 'base64');
        if (!backup.length || backup.length > MAX_BYTES || JSON.parse(backup.toString()).format !== 'magpie-backup') throw new Error();
      } catch { throw new Error('Invalid Magpie sync payload'); }
      const binary = await ensure();
      return withTemp(async (file) => {
        await fs.writeFile(file, backup, { mode: 0o600, flag: 'wx' });
        let output;
        try { output = await run(binary, ['restore', file], { env, input: `${decoded.passphrase}\n` }); }
        catch { throw new Error('Magpie restore failed; some configuration may already have been applied. Retry to finish.'); }
        if (/Couldn't add the plugin/i.test(output)) throw new Error('Magpie restore partially completed: plugin installation failed. Check the target Magpie plugins.');
        if (/Library:.*couldn't/i.test(output)) throw new Error('Magpie restore partially completed: library application failed. Check the target Magpie library.');
        if (/Needs a key/i.test(output)) throw new Error('Magpie restore partially completed: some providers still require API keys.');
        let needsSignIn = /not signed in on this computer/i.test(output);
        if (decoded.format === 'magpie-sync-v2') {
          const dir = await dataDir(binary);
          try {
            await restoreMagpieAuth(dir, decoded.authorization, async (auth) => {
              const credentialFile = path.join(path.dirname(file), 'codex.json');
              try {
                await fs.writeFile(credentialFile, JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
                await run(binary, ['accounts', 'import', 'codex', credentialFile, '--yes'], { env });
              } finally { await fs.rm(credentialFile, { force: true }); }
            });
            const accounts = parseMagpieAccountsJson(await run(binary, ['accounts', '--json'], { env }));
            verifyMagpieAuth(decoded.authorization, accounts);
            const configured = JSON.parse(await fs.readFile(path.join(dir, 'providers.json'), 'utf8').catch((error) => {
              if (error.code === 'ENOENT') return '{"providers":[]}';
              throw error;
            }));
            if (!Array.isArray(configured.providers)) throw new Error();
            const signedIn = new Set(accounts.map((account) => account.agent));
            needsSignIn = decoded.authorization.incomplete || configured.providers.some((provider) =>
              !provider.hidden && provider.id && !['chat', 'responses', 'anthropic', 'gemini'].some((key) => provider[key])
              && !signedIn.has(provider.id));
            if (/Left as they are/i.test(output)) {
              output = await run(binary, ['restore', file], { env, input: `${decoded.passphrase}\n` });
              if (/Couldn't add the plugin|Needs a key|Library:.*couldn't/i.test(output)) throw new Error();
            }
          } catch (error) {
            throw new Error('Magpie authorization sync or verification failed; some configuration and accounts may already be applied. Retry to finish.', { cause: error });
          }
        }
        const magpieWarnings = [];
        if (needsSignIn) magpieWarnings.push('sign_in_required');
        if (/Left as they are/i.test(output)) magpieWarnings.push('agent_settings_skipped');
        return { ok: true, ...(magpieWarnings.length ? { magpieWarnings } : {}) };
      });
    }),
  };
}
