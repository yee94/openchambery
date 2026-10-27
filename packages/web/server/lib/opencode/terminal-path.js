import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function configureOpenCodeTerminalPath(binaryPath, options = {}) {
  const env = options.env || process.env;
  const home = typeof options.homedir === 'function' ? options.homedir() : options.homedir || os.homedir();
  const platform = options.platform || process.platform;
  const dataDir = options.dataDir || env.YURI_DATA_DIR || path.join(home, '.config', 'yuri');
  const directory = path.dirname(binaryPath);
  if (platform === 'win32') {
    const run = options.spawnSync || spawnSync;
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$root = $env:YURI_CLI_CACHE_ROOT.TrimEnd('\\') + '\\'
$entries = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -and -not $_.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
$value = (@($env:YURI_CLI_BIN_DIR) + $entries) -join ';'
[Environment]::SetEnvironmentVariable('Path', $value, 'User')
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class YuriEnvironment { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'
$result = [UIntPtr]::Zero
[void][YuriEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`], { env: { ...env, YURI_CLI_CACHE_ROOT: path.join(dataDir, 'opencode-cli'), YURI_CLI_BIN_DIR: directory },
      encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (result.status !== 0) throw new Error('Cannot add OpenCode to the Windows user PATH');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'opencode-path.windows'), directory);
    return;
  }

  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const kind = path.basename(shell);
  const files = [];
  if (kind === 'zsh') {
    const run = options.spawnSync || spawnSync;
    const probe = run(shell, ['-c', 'printf "%s" "${ZDOTDIR:-$HOME}"'], { env: { ...env, HOME: home }, encoding: 'utf8', timeout: 5000 });
    if (probe.status !== 0 || !path.isAbsolute(probe.stdout || '')) throw new Error('Cannot resolve zsh startup directory');
    files.push(path.join(probe.stdout, '.zprofile'), path.join(probe.stdout, '.zshrc'));
  } else if (kind === 'bash') {
    files.push(path.join(home, '.bashrc'));
    files.push(['.bash_profile', '.bash_login', '.profile'].map((name) => path.join(home, name)).find((file) => fs.existsSync(file)) || path.join(home, '.profile'));
  } else if (['sh', 'dash', 'ksh'].includes(kind)) {
    files.push(path.join(home, '.profile'));
  } else if (kind === 'fish') {
    files.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'config.fish'));
  } else {
    throw new Error(`Cannot configure OpenCode PATH for shell ${kind}`);
  }

  const quote = kind === 'fish'
    ? (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const envFile = path.join(dataDir, kind === 'fish' ? 'opencode-path.fish' : 'opencode-path.sh');
  const content = kind === 'fish'
    ? `contains -- ${quote(directory)} $PATH; or set -gx PATH ${quote(directory)} $PATH\n`
    : `case ":$PATH:" in *${quote(`:${directory}:`)}*) ;; *) export PATH=${quote(directory)}:"$PATH" ;; esac\n`;
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(`${envFile}.tmp`, content, { mode: 0o600 });
  fs.renameSync(`${envFile}.tmp`, envFile);
  const line = `${kind === 'fish' ? 'source' : '.'} ${quote(envFile)} # Yuri OpenCode CLI PATH`;
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing.split('\n').includes(line)) fs.appendFileSync(file, `\n${line}\n`);
  }
}
