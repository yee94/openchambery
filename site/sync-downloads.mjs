import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveRelease } from './assets/downloads.mjs';

const endpoint = 'https://api.github.com/repos/yee94/yuri/releases?per_page=100';
const marker = /\/\* release-snapshot:start \*\/[\s\S]*?\/\* release-snapshot:end \*\//g;

export async function syncDownloads({
  sourcePath = new URL('./assets/downloads.mjs', import.meta.url),
  fetchImpl = fetch,
  token = process.env.GH_TOKEN,
  testFlightUrl = process.env.TESTFLIGHT_PUBLIC_URL,
} = {}) {
  const ios = new URL(testFlightUrl);
  if (ios.origin !== 'https://testflight.apple.com' || !/^\/join\/[A-Za-z0-9]+$/.test(ios.pathname)
    || ios.username || ios.password || ios.search || ios.hash) {
    throw new Error('TESTFLIGHT_PUBLIC_URL must be a public TestFlight invitation');
  }
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(endpoint, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Release catalog request failed: HTTP ${response.status}`);
  const snapshot = resolveRelease(await response.json());
  if (!snapshot) throw new Error('No published installer release found');
  for (const target of ['mac', 'windows', 'linux', 'linuxArm', 'android']) {
    if (!snapshot.targets[target]) throw new Error(`Release ${snapshot.version} is missing ${target} installer`);
  }
  snapshot.targets.ios = ios.href;
  const source = await readFile(sourcePath, 'utf8');
  if ([...source.matchAll(marker)].length !== 1) throw new Error('Expected one release snapshot marker');
  const generated = `/* release-snapshot:start */ Object.freeze(${JSON.stringify(snapshot, null, 2)}) /* release-snapshot:end */`;
  await writeFile(sourcePath, source.replace(marker, () => generated));
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = await syncDownloads();
  console.log(`Website downloads: ${snapshot.version}${snapshot.prerelease ? ' Beta' : ''}; all installers verified`);
}
