import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { ensurePinnedOpenCode2Cli, installPinnedOpenCode2Cli } from './ensure-cli.js';
import { configureOpenCodeTerminalPath } from './terminal-path.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test.each(['/bin/bash', '/bin/zsh'].filter((shell) => fs.existsSync(shell)))('fresh installation is available in %s, preserves rc content and is idempotent', async (shell) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuri cli's "));
  roots.push(home);
  const dataDir = path.join(home, '.config', 'yuri');
  const binary = path.join(dataDir, 'opencode-cli', '2.9.1', 'opencode');
  const zdotdir = path.join(home, 'zsh');
  fs.mkdirSync(zdotdir);
  const rc = shell.endsWith('zsh') ? path.join(zdotdir, '.zshrc') : path.join(home, '.bashrc');
  fs.writeFileSync(rc, '# user configuration\n');
  const options = { pin: '2.9.1', dataDir, homedir: () => home,
    env: { HOME: home, ZDOTDIR: zdotdir, SHELL: shell, PATH: '/usr/bin:/bin' },
    install: vi.fn(async () => {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, '#!/bin/sh\nprintf "2.9.1\\n"\n', { mode: 0o755 });
      return binary;
    }),
  };
  await ensurePinnedOpenCode2Cli(options);
  const first = fs.readFileSync(rc, 'utf8');
  expect(first).toContain('# user configuration\n');
  const result = spawnSync(shell, ['-ic', 'opencode --version'], {
    env: options.env, encoding: 'utf8', timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('2.9.1');
  await ensurePinnedOpenCode2Cli(options);
  expect(fs.readFileSync(rc, 'utf8')).toBe(first);
  expect(options.install).toHaveBeenCalledTimes(1);

  await installPinnedOpenCode2Cli({ ...options, version: '2.10.0',
    fetch: async (url) => String(url).endsWith('/2.10.0')
      ? Response.json({ dist: { tarball: 'https://example.com/cli.tgz' } }) : new Response('fixture'),
    extract: async (_archive, target) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'opencode'), '#!/bin/sh\nprintf "2.10.0\\n"\n');
    },
  });
  const upgraded = spawnSync(shell, ['-ic', 'opencode --version'], { env: options.env, encoding: 'utf8', timeout: 5000 });
  expect(upgraded.status, upgraded.stderr).toBe(0);
  expect(upgraded.stdout.trim()).toBe('2.10.0');
  expect(fs.readFileSync(rc, 'utf8')).toBe(first);
});

test('Windows updates only user PATH using a hidden first-level process and reports failure', () => {
  const spawn = vi.fn(() => ({ status: 0 }));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-win-path-'));
  roots.push(dataDir);
  const binary = path.join(dataDir, 'opencode-cli', '2.9.1', 'opencode.exe');
  const options = { platform: 'win32', dataDir, homedir: dataDir, spawnSync: spawn, env: {} };
  configureOpenCodeTerminalPath(binary, options);
  expect(spawn).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive']), expect.objectContaining({
    windowsHide: true, env: expect.objectContaining({ YURI_CLI_BIN_DIR: path.dirname(binary) }),
  }));
  expect(spawn.mock.calls[0][1].at(-1)).toContain("GetEnvironmentVariable('Path', 'User')");
  spawn.mockReturnValue({ status: 1 });
  expect(() => configureOpenCodeTerminalPath(binary, options)).toThrow('Windows user PATH');
});
