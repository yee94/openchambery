import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateRecovery({ run, jobs, release, tagSha, repository, version }) {
  if (run.repository?.full_name !== repository || run.path !== '.github/workflows/release.yml'
    || run.status !== 'completed' || !['push', 'workflow_dispatch'].includes(run.event)) {
    throw new Error('Recovery requires a completed Release run from this repository.');
  }
  if (run.head_sha !== tagSha || release.tag_name !== `v${version}` || !release.draft) {
    throw new Error('Recovery requires the existing draft and its original tagged source commit.');
  }
  const requiredJobs = [
    ['create-release', 1],
    ['build-desktop-electron-macos (', 1],
    ['build-desktop-electron-windows (', 1],
    ['build-desktop-electron-linux (', 2],
    ['publish-electron-linux', 1],
    ['Publish npm packages', 1],
    ['mobile-release / Android signed release', 1],
  ];
  for (const [prefix, count] of requiredJobs) {
    const matches = jobs.filter(job => job.name.startsWith(prefix));
    if (matches.length !== count || matches.some(job => job.conclusion !== 'success')) {
      throw new Error(`Cannot reuse incomplete build or publication: ${prefix}`);
    }
  }
  const ios = jobs.filter(job => job.name === 'mobile-release / iOS TestFlight upload');
  if (ios.length > 1 || (!version.includes('-') && ios.length !== 1)) {
    throw new Error('Missing or ambiguous iOS upload evidence.');
  }
  for (const job of ios) {
    if (job.conclusion === 'skipped' && version.includes('-')) continue;
    const upload = job.steps?.find(step => step.name === 'Upload to TestFlight');
    if (upload?.conclusion !== 'success') throw new Error('iOS upload did not succeed.');
    if (job.conclusion === 'success') continue;
    const failed = job.steps.filter(step => step.conclusion === 'failure');
    if (job.conclusion !== 'failure' || failed.length !== 1 || failed[0].name !== 'Publish build to external TestFlight group') {
      throw new Error('Only the legacy external-review failure can be recovered without rebuilding iOS.');
    }
  }
  if (!Number.isSafeInteger(run.run_number) || run.run_number <= 0) throw new Error('Invalid original build number.');
  return { source_sha: run.head_sha, build_number: String(run.run_number), release_id: String(release.id) };
}

function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY: repository, RECOVERY_RUN_ID: runId, VERSION: version, GITHUB_OUTPUT: output } = process.env;
  if (!GH_TOKEN || !/^\d+$/.test(runId) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('Authenticated recovery requires a numeric source run and a valid release version.');
  }
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`], { encoding: 'utf8' }));
  const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`], { encoding: 'utf8' })).flat();
  const matches = releases.filter(release => release.tag_name === `v${version}`);
  if (matches.length !== 1) throw new Error('Expected exactly one existing release for recovery.');
  const release = matches[0];
  const tagSha = api(`repos/${repository}/commits/v${version}`).sha;
  const result = validateRecovery({ run, jobs: pages.flatMap(page => page.jobs), release, tagSha, repository, version });
  appendFileSync(output, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`Reusing verified artifacts from Release run ${runId}, build ${result.build_number}, commit ${result.source_sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
