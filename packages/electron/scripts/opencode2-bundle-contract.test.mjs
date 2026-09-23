import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { isOpenCode1xVersion } from '../../web/server/lib/opencode/opencode2-pin.js';
import {
  PINNED_OPENCODE2_VERSION,
  artifactForOpenCode2,
  bundledOpenCode2BinaryName,
  npmPackageForOpenCode2,
  parseOpenCode2VersionOutput,
} from './opencode2-bundle-contract.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const readScript = (name) => fs.readFileSync(path.join(scriptsDir, name), 'utf8');

test('bundled resource uses the official opencode name on every platform', () => {
  assert.equal(bundledOpenCode2BinaryName('darwin'), 'opencode');
  assert.equal(bundledOpenCode2BinaryName('linux'), 'opencode');
  assert.equal(bundledOpenCode2BinaryName('win32'), 'opencode.exe');
  assert.equal(artifactForOpenCode2('darwin', { opencode: 'arm64' }).binary, 'opencode');
  assert.match(artifactForOpenCode2('darwin', { opencode: 'arm64' }).name, /opencode-darwin/);
  assert.equal(isOpenCode1xVersion(PINNED_OPENCODE2_VERSION), false);
});

test('prepare and verify scripts no longer pull 1.18.x or name the binary opencode', () => {
  const prepare = readScript('prepare-opencode-cli.mjs');
  const verify = readScript('verify-opencode-cli.mjs');
  const linux = readScript('verify-linux-appimage.mjs');
  for (const source of [prepare, verify, linux]) {
    assert.doesNotMatch(source, /1\.18/);
    assert.doesNotMatch(source, /@opencode-ai\/sdk/);
    assert.doesNotMatch(source, /opencode-ai\/latest/);
  }
  assert.match(prepare, /opencode2/);
  assert.match(verify, /opencode2/);
  assert.doesNotMatch(prepare, /binary:\s*'opencode'/);
});

test('ssh-manager installs @opencode/cli and probes opencode', () => {
  const ssh = fs.readFileSync(path.join(scriptsDir, '..', 'ssh-manager.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(scriptsDir, '..', 'main.mjs'), 'utf8');
  assert.match(ssh, /@opencode\/cli/);
  assert.match(ssh, /'opencode --version/);
  assert.doesNotMatch(ssh, /OPENCODE_NPM_PACKAGE = 'opencode-ai'/);
  assert.doesNotMatch(ssh, /'opencode2 --version/);
  assert.match(main, /PINNED_OPENCODE2_VERSION|opencode2-pin/);
  assert.doesNotMatch(main, /@opencode-ai\/sdk/);
});

test('npm platform package names map from GitHub artifact variants', () => {
  assert.equal(npmPackageForOpenCode2('darwin', { opencode: 'arm64' }), '@opencode/cli-darwin-arm64');
  assert.equal(npmPackageForOpenCode2('darwin', { opencode: 'x64' }), '@opencode/cli-darwin-x64-baseline');
  assert.equal(npmPackageForOpenCode2('win32', { opencode: 'x64' }), '@opencode/cli-windows-x64-baseline');
  assert.equal(npmPackageForOpenCode2('linux', { opencode: 'arm64' }), '@opencode/cli-linux-arm64');
  assert.throws(() => npmPackageForOpenCode2('freebsd', { opencode: 'x64' }));
});

test('parseOpenCode2VersionOutput handles v2 and 1.x output formats', () => {
  // v2: 首个 token 是二进制名，版本带 v 前缀。
  assert.equal(parseOpenCode2VersionOutput('opencode2 v2.0.12\n'), '2.0.12');
  assert.equal(parseOpenCode2VersionOutput('opencode2 v1.2.3-beta.1'), '1.2.3-beta.1');
  // 1.x: 首 token 即版本号。
  assert.equal(parseOpenCode2VersionOutput('1.18.18\n'), '1.18.18');
  assert.equal(parseOpenCode2VersionOutput(''), '');
  assert.equal(parseOpenCode2VersionOutput(null), '');
  assert.equal(parseOpenCode2VersionOutput('opencode2'), '');
});
