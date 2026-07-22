export const DEFAULT_UPDATE_CHECK_URL = 'https://openchamber-update.edgeone.dev/v1/update/check';

const mapArch = (value) => {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
};

const compareSemver = (left, right) => {
  const a = String(left || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const b = String(right || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const resolveUpdateCheckUrl = (environment = process.env) => {
  const override = typeof environment.OPENCHAMBER_UPDATE_API_URL === 'string'
    ? environment.OPENCHAMBER_UPDATE_API_URL.trim()
    : '';
  return override || DEFAULT_UPDATE_CHECK_URL;
};

export const checkMacOSReleaseUpdate = async ({
  currentVersion,
  environment = process.env,
  fetchImpl = fetch,
  arch = process.arch,
} = {}) => {
  const response = await fetchImpl(resolveUpdateCheckUrl(environment), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appType: 'desktop-electron',
      deviceClass: 'desktop',
      platform: 'macos',
      arch: mapArch(arch),
      channel: 'stable',
      currentVersion,
      instanceMode: 'desktop',
      reportUsage: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`Update service responded with ${response.status}`);
  const update = await response.json();
  const version = typeof update?.latestVersion === 'string' ? update.latestVersion.replace(/^v/, '') : '';
  if (!version) throw new Error('Update service did not provide a version');

  return {
    available: Boolean(update.updateAvailable) && compareSemver(version, currentVersion) > 0,
    currentVersion,
    version,
    body: typeof update.releaseNotes === 'string' ? update.releaseNotes : null,
    date: typeof update.publishedAt === 'string'
      ? update.publishedAt
      : typeof update.date === 'string'
        ? update.date
        : null,
    releaseUrl: typeof update.releaseNotesUrl === 'string'
      ? update.releaseNotesUrl
      : typeof update.releaseUrl === 'string'
        ? update.releaseUrl
        : null,
    manualUpdate: true,
  };
};
