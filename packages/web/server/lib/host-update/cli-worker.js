import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { detectPackageManagerDetails } from '../package-manager.js';
import { writeUpdateState } from './runtime.js';
import { releaseParts } from './releases.js';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Update command failed')));
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));

function prepare(config) {
  if (!Number.isInteger(config.port) || !Number.isInteger(config.pid) || !releaseParts(config.release?.version ?? '0.0.0')) throw new Error('Invalid update configuration');
  const details = detectPackageManagerDetails();
  if (!['install-path-owner', 'global-root-owner', 'cached'].includes(details.reason)
    || fs.realpathSync(details.packagePath) !== fs.realpathSync(config.packageRoot)) throw new Error('Package manager does not own this installation');
  const installationPath = details.globalNodeModulesRoot && path.join(details.globalNodeModulesRoot, '@yuriai', 'web');
  if (!installationPath || fs.realpathSync(installationPath) !== fs.realpathSync(config.packageRoot)) throw new Error('Cannot resolve the stable global package entry');
  const runDir = path.join(config.dataDir, 'run');
  const instance = JSON.parse(fs.readFileSync(path.join(runDir, `yuri-${config.port}.json`), 'utf8'));
  const pid = Number(fs.readFileSync(path.join(runDir, `yuri-${config.port}.pid`), 'utf8'));
  if (pid !== config.pid || instance.launchMode !== 'daemon') throw new Error('Automatic CLI updates require a registered daemon');
  for (const file of fs.readdirSync(runDir)) {
    if (!/^yuri-\d+\.pid$/.test(file) || file === `yuri-${config.port}.pid`) continue;
    const otherPid = Number(fs.readFileSync(path.join(runDir, file), 'utf8'));
    if (Number.isInteger(otherPid) && otherPid > 0 && alive(otherPid)) throw new Error('Stop other CLI instances before updating this installation');
  }
  fs.accessSync(config.packageRoot, fs.constants.W_OK);
  return { details, instance, installationPath };
}

function acquireLock(packageRoot) {
  const key = createHash('sha256').update(path.resolve(packageRoot)).digest('hex').slice(0, 24);
  const directory = path.join(os.homedir(), '.cache', 'yuri', 'update-locks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${key}.lock`);
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never race another worker by unlinking a presumed stale lock. A helper
    // killed outside normal cleanup requires explicit operator recovery.
    throw new Error('Installation update lock exists; check the updater before retrying');
  }
  return () => { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}

let drain;
let cancel;
const drained = new Promise((resolve, reject) => { drain = resolve; cancel = () => reject(new Error('Update handoff cancelled')); });
let started = false;
process.on('message', (message) => {
  if (message?.mode === 'drain') { drain(); return; }
  if (message?.mode === 'cancel') { cancel(); return; }
  if (started) return;
  started = true;
  void (async () => {
    let releaseLock;
    let accepted = false;
    try {
      const config = message;
      const { details, instance, installationPath } = prepare(config);
      if (config.mode === 'probe') { await send({ ready: true }); return; }
      releaseLock = acquireLock(installationPath);
      const metadataResponse = await fetch(`https://registry.npmjs.org/@yuriai/web/${config.release.version}`, { signal: AbortSignal.timeout(10000) });
      if (!metadataResponse.ok || (await metadataResponse.json()).dist?.integrity !== config.release.integrity) throw new Error('Package integrity changed');
      const state = config.state;
      const report = async (patch) => {
        const persisted = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        if (persisted.operation?.id !== state.operation.id) throw new Error('Update task was superseded');
        Object.assign(state.operation, patch, { updatedAt: Date.now() });
        await writeUpdateState(config.stateFile, state);
      };
      await send({ ready: true });
      accepted = true;
      await Promise.race([drained, delay(30000).then(() => { throw new Error('Host did not hand off the update'); })]);
      const deadline = Date.now() + 30000;
      while (alive(config.pid)) {
        if (Date.now() >= deadline) throw new Error('Host did not shut down');
        await delay(100);
      }
      await report({ status: 'installing' });
      const target = `@yuriai/web@${config.release.version}`;
      const args = details.packageManager === 'yarn' ? ['global', 'add', target]
        : details.packageManager === 'npm' ? ['install', '-g', target, '--force'] : ['add', '-g', target];
      let installFailed = false;
      try {
        await run(details.packageManagerCommand, args, { timeout: 10 * 60_000 });
        const installed = JSON.parse(fs.readFileSync(path.join(installationPath, 'package.json'), 'utf8'));
        if (installed.version !== config.release.version) throw new Error('Installed version mismatch');
      } catch { installFailed = true; }
      await report({ status: installFailed ? 'failed' : 'restarting', error: installFailed ? 'cli_install_failed' : null });
      // Password stays in the inherited environment, never argv or task state.
      const restartArgs = [path.join(installationPath, 'bin', 'cli.js'), 'serve', '--port', String(config.port), '--json'];
      if (instance.host) restartArgs.push('--host', instance.host);
      if (instance.apiOnly) restartArgs.push('--api-only');
      await run(process.execPath, restartArgs, { env: { ...process.env, ...(instance.uiPassword ? { YURI_UI_PASSWORD: instance.uiPassword } : {}) }, timeout: 60000 });
      if (!installFailed) {
        const host = instance.host && !['0.0.0.0', '::'].includes(instance.host) ? instance.host : '127.0.0.1';
        const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${config.port}/health`, { signal: AbortSignal.timeout(10000) });
        const health = await response.json();
        if (!response.ok || health.yuriVersion !== config.release.version || (health.serverId && health.serverId !== state.operation.serverId)) throw new Error('Restart version verification failed');
        await report({ status: 'succeeded', progress: 100 });
      }
    } catch {
      if (!accepted) {
        if (process.connected) await send({ error: 'CLI update preflight failed: use a writable global installation with one registered daemon' });
      } else {
        const state = message.state;
        try {
          const persisted = JSON.parse(fs.readFileSync(message.stateFile, 'utf8'));
          if (persisted.operation?.id === state.operation.id) {
            Object.assign(state.operation, { status: 'failed', error: 'cli_update_failed', updatedAt: Date.now() });
            await writeUpdateState(message.stateFile, state);
          }
        } catch { /* A failed durable write must not overwrite another task or prevent lock cleanup. */ }
      }
    } finally {
      releaseLock?.();
      process.exit(0);
    }
  })();
});
