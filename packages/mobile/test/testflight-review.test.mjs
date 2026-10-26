import { afterEach, expect, test } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runReview({ alreadySubmitted = false, rejectReview = false, publicLink = true, version = '0.1.0' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'testflight-review-'));
  roots.push(root);
  const keyPath = path.join(root, 'key.p8');
  writeFileSync(keyPath, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const script = new URL('../../../scripts/publish-testflight-external-build.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const { pathname } = new URL(url);
      calls.push([init.method ?? 'GET', pathname]);
      let status = 200;
      let body;
      if (pathname === '/v1/apps') body = { data: [{ id: 'app' }] };
      else if (pathname === '/v1/builds') body = { data: [
        { id: 'other-train', attributes: { processingState: 'VALID' } },
        { id: 'current', attributes: { processingState: 'VALID' } },
      ] };
      else if (pathname.endsWith('/preReleaseVersion')) body = { data: { attributes: { version: pathname.includes('other-train') ? '0.0.9' : '0.1.0' } } };
      else if (pathname.endsWith('/relationships/builds')) {
        if (JSON.parse(init.body).data[0].id !== 'current') throw new Error('Wrong marketing version selected');
        status = 204;
      }
      else if (pathname.endsWith('/builds')) body = { data: [{ id: 'current' }] };
      else if (pathname.endsWith('/betaAppReviewSubmission')) {
        status = ${alreadySubmitted ? 200 : 404};
        body = ${alreadySubmitted ? "{ data: { id: 'existing-review' } }" : '{}'};
      }
      else if (pathname === '/v1/betaAppReviewSubmissions') {
        status = ${rejectReview ? 422 : 201};
        body = ${rejectReview ? "{ errors: [{ detail: 'Beta App Description is required' }] }" : "{ data: { id: 'new-review' } }"};
      }
      else if (pathname === '/v1/betaGroups/group') body = { data: { attributes: { publicLink: ${publicLink ? "'https://testflight.apple.com/join/example'" : 'null'} } } };
      else throw new Error('Unexpected request: ' + url);
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    };
    process.on('exit', () => console.log(JSON.stringify(calls)));
    await import(${JSON.stringify(script)});
  `], {
    encoding: 'utf8',
    env: { ...process.env, APP_STORE_CONNECT_KEY_ID: 'test', APP_STORE_CONNECT_ISSUER_ID: 'test', APP_STORE_CONNECT_PRIVATE_KEY_PATH: keyPath,
      TESTFLIGHT_BUNDLE_ID: 'com.example.app', TESTFLIGHT_BUILD_NUMBER: '5', TESTFLIGHT_VERSION: version,
      TESTFLIGHT_EXTERNAL_BETA_GROUP_ID: 'group', GITHUB_STEP_SUMMARY: '' },
  });
}

test('submits the existing build from the exact marketing version', () => {
  const result = runReview();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('build 5: submitted');
  expect(result.stdout).toContain('["POST","/v1/betaAppReviewSubmissions"]');
});

test('retrying an already-submitted build does not submit or upload it again', () => {
  const result = runReview({ alreadySubmitted: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('already-submitted');
  expect(result.stdout).not.toContain('["POST","/v1/betaAppReviewSubmissions"]');
});

test('missing review metadata stays a visible failure in the independent workflow', () => {
  const result = runReview({ rejectReview: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Beta App Description is required');
});

test('prereleases cannot enter the external review workflow', () => {
  const result = runReview({ version: '0.1.1-beta.1' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('stable marketing version');
});

test('an email-only group does not turn successful review submission into failure', () => {
  const result = runReview({ alreadySubmitted: true, publicLink: false });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('already-submitted');
  expect(result.stdout).toContain('Public TestFlight link: not enabled');
});
