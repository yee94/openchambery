import assert from 'node:assert/strict';
import { test } from 'vitest';

import { compareReleaseVersions, parseReleaseVersion } from '../lib/semver.js';

test('parseReleaseVersion accepts core, beta, and optional v prefix', () => {
  assert.deepEqual(parseReleaseVersion('1.18.2-beta.30'), {
    major: 1,
    minor: 18,
    patch: 2,
    beta: 30,
  });
  assert.deepEqual(parseReleaseVersion('v1.18.2'), {
    major: 1,
    minor: 18,
    patch: 2,
    beta: null,
  });
  assert.equal(parseReleaseVersion('builtin'), null);
  assert.equal(parseReleaseVersion('34ab092a8e7f6d21'), null);
});

test('compareReleaseVersions orders beta numbers and ranks stable above beta', () => {
  assert.ok(compareReleaseVersions('1.18.2-beta.29', '1.18.2-beta.30') < 0);
  assert.ok(compareReleaseVersions('1.18.2-beta.30', '1.18.2-beta.29') > 0);
  assert.equal(compareReleaseVersions('1.18.2-beta.30', 'v1.18.2-beta.30'), 0);
  assert.ok(compareReleaseVersions('1.18.2', '1.18.2-beta.30') > 0);
  assert.equal(compareReleaseVersions('builtin', '1.18.2-beta.30'), null);
});
