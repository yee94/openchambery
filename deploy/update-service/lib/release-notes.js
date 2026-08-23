import { compareReleaseVersions, parseReleaseVersion } from './semver.js';

const CHANGELOG_PATH = '/CHANGELOG.md';

function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => Number.parseInt(part || '0', 10));

  return {
    parts,
    prerelease: prereleaseIndex >= 0,
  };
}

/**
 * Prefer OpenChamber release ordering (`X.Y.Z` / `X.Y.Z-beta.N`) so beta→beta
 * OTA ranges work; fall back to core+prerelease-flag comparison for other tags.
 */
function compareVersions(left, right) {
  const releaseDiff = compareReleaseVersions(left, right);
  if (releaseDiff !== null) return releaseDiff;

  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) {
    return a.prerelease ? -1 : 1;
  }

  return 0;
}

/**
 * Web-bundle identity for changelog filtering.
 * iOS marketing versions strip `-beta.N` (`1.18.2-beta.36` → `1.18.2`).
 * That stripped stable is newer than every `1.18.2-beta.*`, so it must not
 * be used as "already installed" or every beta note disappears.
 */
export function resolveChangelogCurrentVersion(request) {
  if (parseReleaseVersion(request?.currentBundleId)) {
    return request.currentBundleId;
  }
  const native = parseReleaseVersion(request?.nativeVersion);
  if (native && native.beta !== null) {
    return request.nativeVersion;
  }
  return null;
}

/**
 * Filter CHANGELOG.md sections to versions strictly newer than `currentVersion`
 * and at most `latestVersion`. A null/empty current version keeps only the
 * latest section (unknown installed web bundle).
 */
export function extractReleaseNotes(changelog, currentVersion, latestVersion) {
  const sections = changelog.split(/^## /m).slice(1);
  const relevantSections = sections.filter((section) => {
    const match = section.match(/^\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/);
    if (!match) return false;
    if (currentVersion == null || currentVersion === '') {
      return compareVersions(match[1], latestVersion) === 0;
    }
    return compareVersions(match[1], currentVersion) > 0 && compareVersions(match[1], latestVersion) <= 0;
  });

  if (relevantSections.length === 0) return undefined;
  return relevantSections.map((section) => `## ${section.trim()}`).join('\n\n');
}

/**
 * Load `/CHANGELOG.md` relative to `baseUrl` and extract notes between versions.
 * Failures (network, missing file, empty filter) return `undefined`.
 */
export async function loadReleaseNotes(baseUrl, currentVersion, latestVersion) {
  try {
    const response = await fetch(new URL(CHANGELOG_PATH, baseUrl), {
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
    });
    if (!response.ok) return undefined;
    return extractReleaseNotes(await response.text(), currentVersion, latestVersion);
  } catch {
    return undefined;
  }
}
