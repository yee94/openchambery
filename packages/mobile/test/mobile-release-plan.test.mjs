import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = [];
const script = fileURLToPath(new URL('../../../scripts/mobile-release-plan.mjs', import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuri-release-plan-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'packages/mobile/contracts'), { recursive: true });
  copyFileSync(script, path.join(root, 'scripts/mobile-release-plan.mjs'));
  writeFileSync(path.join(root, 'packages/mobile/contracts/index.mjs'), 'export const mobileBridgeContracts = [];');
  writeFileSync(path.join(root, 'packages/mobile/capacitor.config.ts'), 'const config = { shellApiVersion: 2 };');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.com');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial snapshot');
  const run = (...args) => spawnSync(process.execPath, ['scripts/mobile-release-plan.mjs', '--json', ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, run };
}

test.each([false, true])('first release requires native artifacts (current tag: %s)', (tagged) => {
  const { git, run } = fixture();
  if (tagged) git('tag', 'v0.1.0');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'native', reason: 'first_release', baseTag: null, contractsValid: true, shellApiVersion: 2 });
});

test('a previous release still permits OTA for web-only changes', () => {
  const { root, git, run } = fixture();
  git('tag', 'v0.1.0');
  writeFileSync(path.join(root, 'web.txt'), 'web-only change');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Web changes');
  git('tag', 'v0.1.1');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'ota', baseTag: 'v0.1.0' });
});

test('an explicitly missing base remains an error', () => {
  const { run } = fixture();
  expect(run('--base', 'v9.9.9').status).not.toBe(0);
});

test('old higher-major tags cannot raise the shell floor of the current release line', () => {
  const { root, git, run } = fixture();
  git('tag', 'v2.1.10');
  mkdirSync(path.join(root, 'packages/mobile/ios'), { recursive: true });
  writeFileSync(path.join(root, 'packages/mobile/ios/shell.swift'), 'current shell');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Current release line');
  git('tag', 'v0.1.0');
  writeFileSync(path.join(root, 'web.txt'), 'web-only fix');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Web fix');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'ota', baseTag: 'v0.1.0', changedNativePaths: [] });
});
