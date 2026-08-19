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
} from './opencode2-bundle-contract.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const readScript = (name) => fs.readFileSync(path.join(scriptsDir, name), 'utf8');

test('bundled resource name is opencode2, not 1.x opencode', () => {
  assert.equal(bundledOpenCode2BinaryName('darwin'), 'opencode2');
  assert.equal(bundledOpenCode2BinaryName('linux'), 'opencode2');
  assert.equal(bundledOpenCode2BinaryName('win32'), 'opencode2.exe');
  assert.equal(artifactForOpenCode2('darwin', { opencode: 'arm64' }).binary, 'opencode2');
  assert.match(artifactForOpenCode2('darwin', { opencode: 'arm64' }).name, /opencode2/);
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
