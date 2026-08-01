import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const ASC_API_URL = 'https://api.appstoreconnect.apple.com';
const BUILD_PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;
const BUILD_PROCESSING_POLL_MS = 30 * 1000;
const EXTERNAL_GROUP_BUILD_RETENTION = 3;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const keyId = requireEnv('APP_STORE_CONNECT_KEY_ID');
const issuerId = requireEnv('APP_STORE_CONNECT_ISSUER_ID');
const privateKeyPath = requireEnv('APP_STORE_CONNECT_PRIVATE_KEY_PATH');
const betaGroupId = requireEnv('TESTFLIGHT_EXTERNAL_BETA_GROUP_ID');
const bundleId = requireEnv('TESTFLIGHT_BUNDLE_ID');
const buildNumber = requireEnv('TESTFLIGHT_BUILD_NUMBER');

if (!existsSync(privateKeyPath)) {
  throw new Error(`App Store Connect private key was not found at ${privateKeyPath}.`);
}

const privateKey = createPrivateKey(readFileSync(privateKeyPath));

function createToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}

async function api(path, init = {}) {
  const response = await fetch(`${ASC_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${createToken()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function assertSuccess(result, operation, acceptedStatuses = []) {
  if (result.response.ok || acceptedStatuses.includes(result.response.status)) return result.body;
  const detail = Array.isArray(result.body?.errors)
    ? result.body.errors.map((error) => error.detail || error.title).join('; ')
    : JSON.stringify(result.body);
  throw new Error(`${operation} failed (${result.response.status}): ${detail}`);
}

function query(params) {
  return new URLSearchParams(params).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getApp() {
  const result = await api(`/v1/apps?${query({ 'filter[bundleId]': bundleId, limit: '2' })}`);
  const apps = assertSuccess(result, 'Find App Store Connect app')?.data ?? [];
  if (apps.length !== 1) throw new Error(`Expected one App Store Connect app for ${bundleId}; found ${apps.length}.`);
  return apps[0];
}

async function findBuild(appId) {
  const result = await api(
    `/v1/builds?${query({
      'filter[app]': appId,
      'filter[version]': buildNumber,
      'fields[builds]': 'processingState,version,uploadedDate',
      limit: '10',
    })}`,
  );
  const builds = assertSuccess(result, 'Find uploaded TestFlight build')?.data ?? [];
  if (builds.length > 1) {
    throw new Error(`Expected one build with number ${buildNumber}; found ${builds.length}.`);
  }
  return builds[0] ?? null;
}

async function waitForProcessedBuild(appId) {
  const deadline = Date.now() + BUILD_PROCESSING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const build = await findBuild(appId);
    if (!build) {
      console.log(`TestFlight build ${buildNumber} is not visible yet; retrying in 30 seconds.`);
    } else {
      const state = build.attributes?.processingState;
      if (state === 'VALID') return build;
      if (state === 'FAILED' || state === 'INVALID') {
        throw new Error(`TestFlight build ${buildNumber} processing finished with ${state}.`);
      }
      console.log(`TestFlight build ${buildNumber} processing state: ${state ?? 'unknown'}; retrying in 30 seconds.`);
    }
    await sleep(BUILD_PROCESSING_POLL_MS);
  }
  throw new Error(`Timed out waiting for TestFlight build ${buildNumber} to finish processing.`);
}

async function addBuildToExternalGroup(buildId) {
  const result = await api(`/v1/betaGroups/${betaGroupId}/relationships/builds`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'builds', id: buildId }] }),
  });
  if (result.response.status === 409) return;
  assertSuccess(result, 'Add TestFlight build to external group');
}

async function removeOldExternalGroupBuilds(currentBuildId) {
  const result = await api(
    `/v1/betaGroups/${betaGroupId}/builds?${query({ sort: '-uploadedDate', limit: '200' })}`,
  );
  const builds = assertSuccess(result, 'List external TestFlight group builds')?.data ?? [];
  const retained = new Set([
    currentBuildId,
    ...builds.slice(0, EXTERNAL_GROUP_BUILD_RETENTION).map((build) => build.id),
  ]);
  const removable = builds
    .filter((build) => !retained.has(build.id))
    .map((build) => ({ type: 'builds', id: build.id }));
  if (removable.length === 0) return 0;

  const removed = await api(`/v1/betaGroups/${betaGroupId}/relationships/builds`, {
    method: 'DELETE',
    body: JSON.stringify({ data: removable }),
  });
  assertSuccess(removed, 'Remove old builds from external TestFlight group');
  return removable.length;
}

function isSubmissionLimitReached(result) {
  return result.response.status === 422
    && Array.isArray(result.body?.errors)
    && result.body.errors.some((error) => `${error.detail ?? ''} ${error.title ?? ''}`.includes('Submission limit has been reached'));
}

async function submitBetaReview(build) {
  const existing = await api(`/v1/builds/${build.id}/betaAppReviewSubmission`);
  if (existing.response.ok && existing.body?.data) return 'already-submitted';
  if (existing.response.status !== 404) assertSuccess(existing, 'Read Beta App Review submission');

  const result = await api('/v1/betaAppReviewSubmissions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'betaAppReviewSubmissions',
        relationships: { build: { data: { type: 'builds', id: build.id } } },
      },
    }),
  });
  if (isSubmissionLimitReached(result)) return 'deferred-submission-limit';
  assertSuccess(result, 'Submit build for Beta App Review');
  return 'submitted';
}

async function getPublicLink() {
  const result = await api(`/v1/betaGroups/${betaGroupId}`);
  const group = assertSuccess(result, 'Read external TestFlight group')?.data;
  const publicLink = group?.attributes?.publicLink;
  if (!publicLink) throw new Error(`External TestFlight group ${betaGroupId} has no enabled public link.`);
  return publicLink;
}

async function main() {
  const app = await getApp();
  const build = await waitForProcessedBuild(app.id);
  await addBuildToExternalGroup(build.id);
  let removedBuildCount = 0;
  try {
    removedBuildCount = await removeOldExternalGroupBuilds(build.id);
  } catch (error) {
    console.warn(`External TestFlight group cleanup deferred: ${error instanceof Error ? error.message : error}`);
  }
  const reviewStatus = await submitBetaReview(build);
  const publicLink = await getPublicLink();

  console.log(`External TestFlight build ${buildNumber}: ${reviewStatus}`);
  console.log(`Removed ${removedBuildCount} old build(s) from the external TestFlight group.`);
  console.log(`Public TestFlight link: ${publicLink}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## External TestFlight\n\n- Build: \`${buildNumber}\`\n- Beta review: \`${reviewStatus}\`\n- Old group builds removed: \`${removedBuildCount}\`\n- Public link: ${publicLink}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
