import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_PROFILE_ENV, electronBuilderArgsForProfile, resolveDesktopProfile } from './desktop-profile.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const env = { ...process.env };
const builderArgs = process.argv.slice(2);
const profile = resolveDesktopProfile(env);
const targetArchitecture = resolveTargetArchitecture({ environment: env, builderArgs });

// Propagate the resolved profile so after-pack / child tools see a stable value.
env[DESKTOP_PROFILE_ENV] = profile.id;

if (process.platform === 'win32' && !env.CSC_LINK && !env.WINDOWS_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  process.platform === 'win32' ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (process.platform === 'win32' ? 'bun.exe' : 'bun');

if (process.platform === 'linux' && !builderArgs.some((argument) => (
  argument === '--x64' || argument === '--arm64' || argument === '--arch' || argument.startsWith('--arch=')
))) {
  builderArgs.push(`--${targetArchitecture.electronBuilder}`);
}

/** Ensure preview icon assets exist before packaging. */
const ensurePreviewIcons = () => {
  const required = [
    path.join(packageRoot, profile.icons.mac),
    path.join(packageRoot, profile.icons.win),
    path.join(packageRoot, profile.icons.linux),
  ];
  if (required.every((filePath) => fs.existsSync(filePath))) return;
  console.log('[electron] generating missing preview icons…');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'generate-preview-icons.mjs')], {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('Failed to generate preview icons. Install Pillow (`pip3 install pillow`) and rerun.');
  }
  for (const filePath of required) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Preview icon still missing after generation: ${filePath}`);
    }
  }
};

/**
 * For preview, temporarily stage badged icons as the package.json extraResources
 * sources (icon.png / icon.ico), then restore production files after packaging.
 * @returns {() => void} restore function
 */
const stagePreviewResourceIcons = () => {
  if (profile.id !== 'preview') return () => {};
  const targets = [
    {
      live: path.join(packageRoot, 'resources/icons/icon.png'),
      source: path.join(packageRoot, profile.icons.packagedPng),
    },
    {
      live: path.join(packageRoot, 'resources/icons/icon.ico'),
      source: path.join(packageRoot, profile.icons.packagedIco),
    },
  ];
  const backups = [];
  for (const { live, source } of targets) {
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(live)) {
      const backup = `${live}.release-backup`;
      fs.copyFileSync(live, backup);
      backups.push({ live, backup });
    }
    fs.copyFileSync(source, live);
  }
  return () => {
    for (const { live, backup } of backups) {
      try {
        fs.copyFileSync(backup, live);
        fs.unlinkSync(backup);
      } catch {
        // Best-effort restore of production icons after packaging.
      }
    }
  };
};

if (profile.id === 'preview') {
  ensurePreviewIcons();
}

console.log(`[electron] packaging profile=${profile.id} productName=${profile.productName} output=${profile.outputDir}`);

const finalArgs = [...electronBuilderArgsForProfile(profile), ...builderArgs];
const restoreIcons = stagePreviewResourceIcons();

const child = spawn(bunBinary, ['x', 'electron-builder', ...finalArgs], {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
});

const finish = (code, signal) => {
  restoreIcons();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
};

child.on('exit', (code, signal) => finish(code, signal));
child.on('error', (error) => {
  restoreIcons();
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
