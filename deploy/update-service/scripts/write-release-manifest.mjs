import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'release-manifest.json');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASES_URL = 'https://github.com/yee94/openchamber/releases';
const version = String(process.argv[2] || '').trim().replace(/^v/, '');

if (!VERSION_PATTERN.test(version)) {
  throw new Error('Usage: node scripts/write-release-manifest.mjs <version>');
}

function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  return {
    parts: core.split('.').map((part) => Number.parseInt(part || '0', 10)),
    prerelease: prereleaseIndex >= 0,
  };
}

function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
}

const existingManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const existingVersion = typeof existingManifest.latestVersion === 'string'
  ? existingManifest.latestVersion.trim()
  : '';

if (VERSION_PATTERN.test(existingVersion) && compareVersions(existingVersion, version) > 0) {
  console.log(`Keeping newer published update manifest v${existingVersion}.`);
} else {
  writeFileSync(manifestPath, `${JSON.stringify({
    latestVersion: version,
    releaseNotesUrl: `${RELEASES_URL}/tag/v${version}`,
    nextSuggestedCheckInSec: 3600,
  }, null, 2)}\n`);
}
