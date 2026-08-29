import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(projectRoot, '../..');
const configuredOutputDirectory = process.env.OPENCHAMBER_UPDATE_OUTPUT_DIR || 'public';
const outputDirectory = path.resolve(projectRoot, configuredOutputDirectory);
const projectRootPrefix = `${projectRoot}${path.sep}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GITHUB_CHANGELOG_URL = 'https://raw.githubusercontent.com/yee94/openchamber/main/CHANGELOG.md';
const OTA_CHANNELS = ['beta', 'stable'];

if (!outputDirectory.startsWith(projectRootPrefix)) {
  throw new Error('OPENCHAMBER_UPDATE_OUTPUT_DIR must stay inside deploy/update-service.');
}

const { parseOtaManifest } = await import(pathToFileURL(path.join(projectRoot, 'lib', 'ota-manifest.js')).href);

const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'release-manifest.json'), 'utf8'));
const latestVersion = typeof manifest.latestVersion === 'string' ? manifest.latestVersion.trim() : '';
const releaseNotesUrl = typeof manifest.releaseNotesUrl === 'string' ? manifest.releaseNotesUrl.trim() : '';
const nextSuggestedCheckInSec = Number.isInteger(manifest.nextSuggestedCheckInSec)
  && manifest.nextSuggestedCheckInSec >= 60
  && manifest.nextSuggestedCheckInSec <= 86_400
  ? manifest.nextSuggestedCheckInSec
  : 3600;

if (!VERSION_PATTERN.test(latestVersion) || !releaseNotesUrl.startsWith('https://')) {
  throw new Error('release-manifest.json must contain a version and HTTPS releaseNotesUrl.');
}

for (const channel of OTA_CHANNELS) {
  const channelPath = path.join(projectRoot, 'ota', 'channels', `${channel}.json`);
  if (!existsSync(channelPath)) {
    throw new Error(`ota/channels/${channel}.json is required.`);
  }
  const channelManifest = JSON.parse(readFileSync(channelPath, 'utf8'));
  const parsed = parseOtaManifest(channelManifest);
  if (!parsed.ok) {
    throw new Error(`ota/channels/${channel}.json failed schema validation: ${parsed.errors.join('; ')}`);
  }
  if (parsed.manifest.channel !== channel) {
    throw new Error(`ota/channels/${channel}.json channel field must be "${channel}" (got "${parsed.manifest.channel}")`);
  }
}

const outputManifest = {
  latestVersion,
  releaseNotesUrl,
  nextSuggestedCheckInSec,
};

async function resolveChangelogSource() {
  const monorepoChangelog = path.join(repositoryRoot, 'CHANGELOG.md');
  if (existsSync(monorepoChangelog)) return { kind: 'file', path: monorepoChangelog };

  const localChangelog = path.join(projectRoot, 'CHANGELOG.md');
  if (existsSync(localChangelog)) return { kind: 'file', path: localChangelog };

  const response = await fetch(GITHUB_CHANGELOG_URL, {
    headers: { Accept: 'text/markdown, text/plain;q=0.9' },
  });
  if (!response.ok) {
    throw new Error(`Unable to load CHANGELOG.md (HTTP ${response.status}).`);
  }
  return { kind: 'text', text: await response.text() };
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
// EdgeOne serves /CHANGELOG.md through edge-functions/CHANGELOG.md.js and
// static assets shadow edge functions — so the EdgeOne build must not emit
// CHANGELOG.md. Vercel still needs the static file for origin + edge functions.
const skipChangelogCopy = process.env.OPENCHAMBER_UPDATE_SKIP_CHANGELOG_COPY === '1';
if (!skipChangelogCopy) {
  const changelogSource = await resolveChangelogSource();
  if (changelogSource.kind === 'file') {
    cpSync(changelogSource.path, path.join(outputDirectory, 'CHANGELOG.md'));
  } else {
    writeFileSync(path.join(outputDirectory, 'CHANGELOG.md'), changelogSource.text);
  }
}
writeFileSync(path.join(outputDirectory, 'update-manifest.json'), `${JSON.stringify(outputManifest, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'health.json'), `${JSON.stringify({
  service: 'openchamber-update',
  latestVersion,
}, null, 2)}\n`);

// EdgeOne serves /ota/* through the edge reverse proxy (edge-functions/ota)
// and static assets shadow edge functions there — so the EdgeOne build must
// not emit the seed tree. Vercel serves /ota/* as real static files.
const skipOtaCopy = process.env.OPENCHAMBER_UPDATE_SKIP_OTA_COPY === '1';
if (!skipOtaCopy) {
  const otaSource = path.join(projectRoot, 'ota');
  cpSync(otaSource, path.join(outputDirectory, 'ota'), { recursive: true });
}
