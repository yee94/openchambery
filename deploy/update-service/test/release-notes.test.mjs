import assert from 'node:assert/strict';
import { test } from 'vitest';

import { extractReleaseNotes, resolveChangelogCurrentVersion } from '../lib/release-notes.js';

const changelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.18.2-beta.37] - 2026-08-23',
  '',
  '- Stop same-version OTA loop',
  '',
  '## [1.18.2-beta.36] - 2026-08-23',
  '',
  '- Already installed',
].join('\n');

test('beta current version includes newer beta notes', () => {
  assert.equal(
    extractReleaseNotes(changelog, '1.18.2-beta.36', '1.18.2-beta.37'),
    '## [1.18.2-beta.37] - 2026-08-23\n\n- Stop same-version OTA loop',
  );
});

test('stripped iOS marketing version must not hide beta notes', () => {
  const current = resolveChangelogCurrentVersion({
    nativeVersion: '1.18.2',
    currentBundleId: '1.18.2-beta.36',
  });
  assert.equal(current, '1.18.2-beta.36');
  assert.equal(
    extractReleaseNotes(changelog, current, '1.18.2-beta.37'),
    '## [1.18.2-beta.37] - 2026-08-23\n\n- Stop same-version OTA loop',
  );
});

test('unknown web bundle still returns the latest section', () => {
  assert.equal(
    extractReleaseNotes(changelog, null, '1.18.2-beta.37'),
    '## [1.18.2-beta.37] - 2026-08-23\n\n- Stop same-version OTA loop',
  );
});
