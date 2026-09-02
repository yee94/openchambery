import { loadOtaChannelManifest } from './ota-manifest.js';
import { resolveMobileUpdate } from './ota-resolver.js';
import { loadReleaseNotes, resolveChangelogCurrentVersion } from './release-notes.js';

const ALLOWED_CHANNELS = new Set(['beta', 'stable']);
const ALLOWED_PLATFORMS = new Set(['ios', 'android']);

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function methodGate(request) {
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

  return null;
}

async function readJsonBody(request) {
  try {
    return { ok: true, payload: await request.json() };
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Request body must contain JSON' }, { status: 400 }) };
  }
}

/**
 * Validate the internal mobile update-check request body.
 * Returns `{ ok: true, request }` or `{ ok: false, response }`.
 */
function parseMobileUpdateRequest(payload) {
  if (!isRecord(payload)) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Request body must be an object' }, { status: 400 }),
    };
  }

  const channel = payload.channel;
  const platform = payload.platform;
  const deviceId = payload.deviceId;
  const nativeVersion = payload.nativeVersion;
  const nativeBuild = payload.nativeBuild;
  const shellApiVersion = payload.shellApiVersion;
  const currentBundleId = payload.currentBundleId;

  if (!ALLOWED_CHANNELS.has(channel)) {
    return { ok: false, response: jsonResponse({ error: 'Invalid channel' }, { status: 400 }) };
  }
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return { ok: false, response: jsonResponse({ error: 'Invalid platform' }, { status: 400 }) };
  }
  if (!isNonEmptyString(deviceId)) {
    return { ok: false, response: jsonResponse({ error: 'Invalid deviceId' }, { status: 400 }) };
  }
  if (!isNonEmptyString(nativeVersion)) {
    return { ok: false, response: jsonResponse({ error: 'Invalid nativeVersion' }, { status: 400 }) };
  }
  if (!Number.isInteger(nativeBuild) || nativeBuild < 1) {
    return { ok: false, response: jsonResponse({ error: 'Invalid nativeBuild' }, { status: 400 }) };
  }
  if (!Number.isInteger(shellApiVersion) || shellApiVersion < 1) {
    return { ok: false, response: jsonResponse({ error: 'Invalid shellApiVersion' }, { status: 400 }) };
  }
  if (!isNonEmptyString(currentBundleId)) {
    return { ok: false, response: jsonResponse({ error: 'Invalid currentBundleId' }, { status: 400 }) };
  }

  const request = {
    channel,
    platform,
    deviceId: deviceId.trim(),
    nativeVersion: nativeVersion.trim(),
    nativeBuild,
    shellApiVersion,
    currentBundleId: currentBundleId.trim(),
  };

  if (payload.installSource !== undefined) {
    if (!isNonEmptyString(payload.installSource)) {
      return { ok: false, response: jsonResponse({ error: 'Invalid installSource' }, { status: 400 }) };
    }
    request.installSource = payload.installSource.trim();
  }

  return { ok: true, request };
}

/**
 * Map Capgo self-hosted check body (snake_case) onto the internal request shape.
 */
function parseCapgoRequest(payload) {
  if (!isRecord(payload)) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Request body must be an object' }, { status: 400 }),
    };
  }

  const channel = payload.defaultChannel ?? payload.channel;
  const platform = payload.platform;
  const deviceId = payload.device_id ?? payload.deviceId;
  // Capgo: version_build is the native marketing version; version_code is the native build number.
  const nativeVersion = payload.version_build ?? payload.nativeVersion;
  let nativeBuild = payload.version_code ?? payload.nativeBuild;
  if (typeof nativeBuild === 'string' && /^\d+$/.test(nativeBuild.trim())) {
    nativeBuild = Number.parseInt(nativeBuild.trim(), 10);
  }
  let shellApiVersion = payload.shellApiVersion ?? payload.shell_api_version ?? 1;
  if (typeof shellApiVersion === 'string' && /^\d+$/.test(shellApiVersion.trim())) {
    shellApiVersion = Number.parseInt(shellApiVersion.trim(), 10);
  }
  // Capgo version_name is the current bundle id/version or 'builtin'.
  const currentBundleId = payload.currentBundleId
    ?? payload.version_name
    ?? 'builtin';

  return parseMobileUpdateRequest({
    channel: channel === 'production' ? 'stable' : channel,
    platform,
    deviceId,
    nativeVersion: typeof nativeVersion === 'string' ? nativeVersion : '',
    nativeBuild,
    shellApiVersion,
    currentBundleId: typeof currentBundleId === 'string' ? currentBundleId : 'builtin',
    ...(payload.installSource !== undefined ? { installSource: payload.installSource } : {}),
  });
}

function absoluteBundleUrl(requestUrl, relativeUrl) {
  return new URL(relativeUrl, new URL(requestUrl).origin).toString();
}

function withAbsoluteBundleUrl(decision, requestUrl) {
  if (!decision.ota?.bundle?.url) return decision;
  return {
    ...decision,
    ota: {
      ...decision.ota,
      bundle: {
        ...decision.ota.bundle,
        url: absoluteBundleUrl(requestUrl, decision.ota.bundle.url),
      },
    },
  };
}

function toCapgoResponse(decision) {
  if (decision.primaryAction === 'apply_ota' && decision.ota?.bundle) {
    const payload = {
      version: decision.ota.bundle.releaseVersion,
      url: decision.ota.bundle.url,
      checksum: decision.ota.bundle.checksum,
    };
    if (decision.ota.bundle.sessionKey !== undefined) {
      // The plugin reads the session key under different names per platform:
      // Android parses `sessionKey`, iOS parses `session_key`. Emit both.
      payload.session_key = decision.ota.bundle.sessionKey;
      payload.sessionKey = decision.ota.bundle.sessionKey;
    }
    if (decision.isChannelRollback === true) {
      payload.is_channel_rollback = true;
    }
    return payload;
  }

  if (decision.primaryAction === 'install_native_required') {
    return {
      major: true,
      breaking: true,
      message: 'native update required',
    };
  }

  return {
    message: 'No new version available',
    version: '',
    url: '',
  };
}

async function withReleaseNotes(decision, parsedRequest, changelogBaseUrl) {
  if (decision.primaryAction !== 'apply_ota' || !decision.ota?.bundle?.releaseVersion) {
    return decision;
  }

  const releaseNotes = await loadReleaseNotes(
    changelogBaseUrl,
    resolveChangelogCurrentVersion(parsedRequest),
    decision.ota.bundle.releaseVersion,
  );
  if (!releaseNotes) return decision;
  return { ...decision, releaseNotes };
}

async function runUpdateCheck(request, parsedRequest, manifestBaseUrl) {
  // By default manifests and CHANGELOG load relative to the request origin
  // (fast on Vercel, where they are static files). EdgeOne deployments must
  // override this with the Vercel origin: /ota/* and /CHANGELOG.md on EdgeOne
  // are reverse-proxied (or, if CHANGELOG is still a git-time static file,
  // stale). Fetching either from an edge endpoint would loop or filter notes
  // against an outdated changelog and omit releaseNotes.
  const assetBaseUrl = manifestBaseUrl ?? request.url;
  const manifest = await loadOtaChannelManifest(assetBaseUrl, parsedRequest.channel);
  if (manifest === null) {
    // Distinguish missing channel file (null from fetch miss) vs load failure:
    // loadOtaChannelManifest returns null for both fetch failure and invalid JSON.
    // Spec: manifest load failure → 503. Channel-not-using-OTA is represented by a
    // present file with activeBundle:null, which parses successfully.
    // A missing/unreachable channel file is treated as unavailable (503), not empty success.
    return jsonResponse({ error: 'ota_manifest_unavailable' }, { status: 503 });
  }

  const decision = await withReleaseNotes(
    withAbsoluteBundleUrl(
      resolveMobileUpdate(manifest, parsedRequest),
      request.url,
    ),
    parsedRequest,
    assetBaseUrl,
  );
  return jsonResponse(decision);
}

export async function handleMobileUpdateCheck(request, options = {}) {
  const gated = methodGate(request);
  if (gated) return gated;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = parseMobileUpdateRequest(body.payload);
  if (!parsed.ok) return parsed.response;

  return runUpdateCheck(request, parsed.request, options.manifestBaseUrl);
}

export async function handleCapgoOtaCheck(request, options = {}) {
  const gated = methodGate(request);
  if (gated) return gated;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = parseCapgoRequest(body.payload);
  if (!parsed.ok) return parsed.response;

  const manifest = await loadOtaChannelManifest(
    options.manifestBaseUrl ?? request.url,
    parsed.request.channel,
  );
  if (manifest === null) {
    return jsonResponse({ error: 'ota_manifest_unavailable' }, { status: 503 });
  }

  const decision = withAbsoluteBundleUrl(
    resolveMobileUpdate(manifest, parsed.request),
    request.url,
  );
  return jsonResponse(toCapgoResponse(decision));
}
