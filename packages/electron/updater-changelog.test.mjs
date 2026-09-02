import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  changelogUrlFromUpdaterFeed,
  filterRelevantChangelogNotes,
  parseRelevantChangelogNotes,
} from './updater-changelog.mjs';
import {
  PRODUCTION_CHANGELOG_URL,
  PRODUCTION_UPDATER_FEED,
} from './updater-feed.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

const sampleChangelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.19.0-beta.8] - 2026-08-29',
  '',
  '- Latest beta',
  '',
  '## [1.19.0-beta.7] - 2026-08-29',
  '',
  '- Mid beta',
  '',
  '## [1.19.0-beta.1] - 2026-08-29',
  '',
  '- First beta',
  '',
  '## [1.18.0] - 2026-08-01',
  '',
  '- Stable',
].join('\n');

test('changelog URL is derived from the production updater feed origin', () => {
  assert.equal(
    changelogUrlFromUpdaterFeed(PRODUCTION_UPDATER_FEED.url),
    PRODUCTION_CHANGELOG_URL,
  );
  assert.equal(
    PRODUCTION_CHANGELOG_URL,
    'https://openchamber-update.vercel.app/CHANGELOG.md',
  );
});

test('filters sections strictly after fromVersion and at most toVersion', () => {
  const notes = filterRelevantChangelogNotes(
    sampleChangelog,
    '1.19.0-beta.1',
    '1.19.0-beta.8',
    compareVersions,
  );
  assert.match(notes, /1\.19\.0-beta\.8/);
  assert.match(notes, /1\.19\.0-beta\.7/);
  assert.doesNotMatch(notes, /1\.19\.0-beta\.1/);
  assert.doesNotMatch(notes, /1\.18\.0/);
  assert.doesNotMatch(notes, /Unreleased/);
});

test('returns null when no sections match the range', () => {
  assert.equal(
    filterRelevantChangelogNotes(sampleChangelog, '1.19.0-beta.8', '1.19.0-beta.8', compareVersions),
    null,
  );
});

test('parseRelevantChangelogNotes fetches the given URL with a 10s timeout', async () => {
  const calls = [];
  const notes = await parseRelevantChangelogNotes({
    changelogUrl: 'https://example.test/CHANGELOG.md',
    fromVersion: '1.19.0-beta.7',
    toVersion: '1.19.0-beta.8',
    compareVersions,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        text: async () => sampleChangelog,
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/CHANGELOG.md');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.match(notes, /1\.19\.0-beta\.8/);
  assert.doesNotMatch(notes, /1\.19\.0-beta\.7/);
});

test('parseRelevantChangelogNotes returns null on network / HTTP failure', async () => {
  assert.equal(
    await parseRelevantChangelogNotes({
      changelogUrl: 'https://example.test/CHANGELOG.md',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      compareVersions,
      fetchImpl: async () => ({ ok: false, text: async () => '' }),
    }),
    null,
  );
  assert.equal(
    await parseRelevantChangelogNotes({
      changelogUrl: 'https://example.test/CHANGELOG.md',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      compareVersions,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    null,
  );
  assert.equal(
    await parseRelevantChangelogNotes({
      changelogUrl: null,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      compareVersions,
    }),
    null,
  );
});
