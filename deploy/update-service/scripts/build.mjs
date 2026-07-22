import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(projectRoot, '../..');
const configuredOutputDirectory = process.env.OPENCHAMBER_UPDATE_OUTPUT_DIR || 'dist';
const outputDirectory = path.resolve(projectRoot, configuredOutputDirectory);
const projectRootPrefix = `${projectRoot}${path.sep}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!outputDirectory.startsWith(projectRootPrefix)) {
  throw new Error('OPENCHAMBER_UPDATE_OUTPUT_DIR must stay inside deploy/update-service.');
}

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

const outputManifest = {
  latestVersion,
  releaseNotesUrl,
  nextSuggestedCheckInSec,
};

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(path.join(repositoryRoot, 'CHANGELOG.md'), path.join(outputDirectory, 'CHANGELOG.md'));
writeFileSync(path.join(outputDirectory, 'update-manifest.json'), `${JSON.stringify(outputManifest, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'health.json'), `${JSON.stringify({
  service: 'openchamber-update',
  latestVersion,
}, null, 2)}\n`);
