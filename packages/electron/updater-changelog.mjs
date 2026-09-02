/**
 * Desktop update-dialog fallback release notes.
 *
 * electron-updater generic feeds usually omit releaseNotes, so the dialog
 * falls back to filtering /CHANGELOG.md from the same update-service origin
 * that already serves the desktop feed (branch-independent, deploy-authoritative).
 */

export const changelogUrlFromUpdaterFeed = (feedUrl) => {
  try {
    return new URL('/CHANGELOG.md', feedUrl).toString();
  } catch {
    return null;
  }
};

/**
 * Keep sections strictly newer than `fromVersion` and at most `toVersion`.
 * Returns null when nothing matches.
 */
export const filterRelevantChangelogNotes = (changelog, fromVersion, toVersion, compareVersions) => {
  const sections = String(changelog || '').split(/^##\s+\[/m).slice(1);
  const relevant = [];
  for (const section of sections) {
    const version = section.split(']')[0];
    if (compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0) {
      relevant.push(`## [${section}`.trim());
    }
  }
  return relevant.length > 0 ? relevant.join('\n\n') : null;
};

/**
 * Fetch and filter changelog notes. Preserves the historical contract:
 * 10s timeout, return null on any failure / empty match.
 */
export const parseRelevantChangelogNotes = async ({
  changelogUrl,
  fromVersion,
  toVersion,
  compareVersions,
  fetchImpl = globalThis.fetch,
}) => {
  if (!changelogUrl || typeof compareVersions !== 'function') return null;
  try {
    const response = await fetchImpl(changelogUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const changelog = await response.text();
    return filterRelevantChangelogNotes(changelog, fromVersion, toVersion, compareVersions);
  } catch {
    return null;
  }
};
