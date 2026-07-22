const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEFAULT_CHECK_INTERVAL_SECONDS = 3600;
const MANIFEST_PATH = '/update-manifest.json';
const CHANGELOG_PATH = '/CHANGELOG.md';

function responseHeaders(headers = {}) {
  return {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders({
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    }),
  });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128 || !VERSION_PATTERN.test(normalized)) return null;
  return normalized.replace(/^v/, '');
}

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

function compareVersions(left, right) {
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

function normalizeHttpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseManifest(value) {
  if (!isRecord(value)) return null;

  const latestVersion = normalizeVersion(value.latestVersion);
  const releaseNotesUrl = normalizeHttpsUrl(value.releaseNotesUrl);
  const nextSuggestedCheckInSec = Number.isInteger(value.nextSuggestedCheckInSec)
    && value.nextSuggestedCheckInSec >= 60
    && value.nextSuggestedCheckInSec <= 86_400
    ? value.nextSuggestedCheckInSec
    : DEFAULT_CHECK_INTERVAL_SECONDS;

  if (!latestVersion || !releaseNotesUrl) return null;

  return {
    latestVersion,
    releaseNotesUrl,
    nextSuggestedCheckInSec,
  };
}

async function loadManifest(request) {
  const response = await fetch(new URL(MANIFEST_PATH, request.url), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Update manifest request failed');

  const manifest = parseManifest(await response.json());
  if (!manifest) throw new Error('Update manifest is invalid');
  return manifest;
}

function extractReleaseNotes(changelog, currentVersion, latestVersion) {
  const sections = changelog.split(/^## /m).slice(1);
  const relevantSections = sections.filter((section) => {
    const match = section.match(/^\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/);
    if (!match) return false;
    return compareVersions(match[1], currentVersion) > 0 && compareVersions(match[1], latestVersion) <= 0;
  });

  if (relevantSections.length === 0) return undefined;
  return relevantSections.map((section) => `## ${section.trim()}`).join('\n\n');
}

async function loadReleaseNotes(request, currentVersion, latestVersion) {
  try {
    const response = await fetch(new URL(CHANGELOG_PATH, request.url), {
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
    });
    if (!response.ok) return undefined;
    return extractReleaseNotes(await response.text(), currentVersion, latestVersion);
  } catch {
    return undefined;
  }
}

export async function onRequest(context) {
  const { request } = context;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders() });
  }

  if (method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, {
      status: 405,
      headers: { Allow: 'POST, OPTIONS' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must contain JSON' }, { status: 400 });
  }

  if (!isRecord(payload)) {
    return jsonResponse({ error: 'Request body must be an object' }, { status: 400 });
  }

  const currentVersion = normalizeVersion(payload.currentVersion);

  let manifest;
  try {
    manifest = await loadManifest(request);
  } catch {
    return jsonResponse({ error: 'Update manifest is unavailable' }, { status: 503 });
  }

  const updateAvailable = currentVersion !== null
    && compareVersions(manifest.latestVersion, currentVersion) > 0;
  const releaseNotes = updateAvailable
    ? await loadReleaseNotes(request, currentVersion, manifest.latestVersion)
    : undefined;

  return jsonResponse({
    latestVersion: manifest.latestVersion,
    currentVersion: currentVersion || 'unknown',
    updateAvailable,
    releaseNotesUrl: manifest.releaseNotesUrl,
    nextSuggestedCheckInSec: manifest.nextSuggestedCheckInSec,
    ...(releaseNotes ? { releaseNotes } : {}),
  });
}
