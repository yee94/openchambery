const releaseEndpoint = 'https://api.github.com/repos/yee94/yuri/releases?per_page=20';

// Verified public release: also consumed at build time for the no-JavaScript HTML.
export const snapshot = /* release-snapshot:start */ Object.freeze({
  "version": "0.1.1",
  "prerelease": false,
  "targets": {
    "mac": "https://github.com/yee94/yuri/releases/download/v0.1.1/Yuri-0.1.1-mac-arm64.dmg",
    "windows": "https://github.com/yee94/yuri/releases/download/v0.1.1/Yuri-0.1.1-win-x64.exe",
    "linux": "https://github.com/yee94/yuri/releases/download/v0.1.1/Yuri-0.1.1-linux-x86_64.AppImage",
    "linuxArm": "https://github.com/yee94/yuri/releases/download/v0.1.1/Yuri-0.1.1-linux-arm64.AppImage",
    "android": "https://github.com/yee94/yuri/releases/download/v0.1.1/app-release.apk",
    "ios": "https://testflight.apple.com/join/pN5SSHeg"
  }
}) /* release-snapshot:end */;

/** Select one complete release; absent assets are null, never borrowed from another version. */
export function resolveRelease(releases) {
  if (!Array.isArray(releases)) throw new TypeError('Expected a release array');
  const candidates = releases.filter((release) => release && !release.draft
    && typeof release.tag_name === 'string' && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name)
    && typeof release.prerelease === 'boolean' && Array.isArray(release.assets));
  const published = (release) => Date.parse(release.published_at || release.created_at) || 0;
  const isBeta = (release) => release.prerelease || release.tag_name.includes('-');
  candidates.sort((a, b) => Number(isBeta(a)) - Number(isBeta(b))
    || published(b) - published(a)
    || b.tag_name.localeCompare(a.tag_name, 'en', { numeric: true }));
  const release = candidates[0];
  if (!release) return null;

  const version = release.tag_name.replace(/^v/, '');
  const names = {
    mac: `Yuri-${version}-mac-arm64.dmg`,
    windows: `Yuri-${version}-win-x64.exe`,
    linux: `Yuri-${version}-linux-x86_64.AppImage`,
    linuxArm: `Yuri-${version}-linux-arm64.AppImage`,
    android: 'app-release.apk',
  };
  const targets = { mac: null, windows: null, linux: null, linuxArm: null, android: null, ios: snapshot.targets.ios };
  for (const [platform, name] of Object.entries(names)) {
    const asset = release.assets.find((item) => item?.name === name);
    if (typeof asset?.browser_download_url !== 'string') continue;
    try {
      const url = new URL(asset.browser_download_url);
      const expectedPath = `/yee94/yuri/releases/download/${release.tag_name}/${name}`;
      if (url.origin === 'https://github.com' && !url.username && !url.password
        && decodeURIComponent(url.pathname) === expectedPath && !url.search && !url.hash) {
        targets[platform] = asset.browser_download_url;
      }
    } catch {
      // Malformed asset metadata is unavailable, not a reason to synthesize a URL.
    }
  }
  return { version, prerelease: isBeta(release), targets };
}

/** Return a target key, or null when the OS/CPU cannot safely select an installer. */
export function detectPlatform(navigatorLike = {}, hints = {}) {
  const ua = String(navigatorLike.userAgent || '');
  const platform = String(navigatorLike.platform || '');
  const data = navigatorLike.userAgentData || {};
  const os = String(hints.platform || data.platform || platform);
  if (/iPhone|iPad|iPod/i.test(ua) || /iOS/i.test(os)
    || (platform === 'MacIntel' && Number(navigatorLike.maxTouchPoints) > 1)) return 'ios';
  if (/Android/i.test(`${ua} ${os}`)) return 'android';

  const architecture = String(hints.architecture || data.architecture || '').toLowerCase();
  const bitness = String(hints.bitness || data.bitness || '');
  let cpu = null;
  if (architecture) {
    if ((architecture === 'arm' && bitness === '64') || /^(arm64|aarch64)$/.test(architecture)) cpu = 'arm64';
    if ((architecture === 'x86' && bitness === '64') || /^(x86_64|x64|amd64)$/.test(architecture)) cpu = 'x64';
  } else {
    const evidence = `${ua} ${platform}`;
    if (/\b(aarch64|arm64)\b/i.test(evidence)) cpu = 'arm64';
    else if (/\b(arm|armv\d\w*)\b/i.test(evidence)) cpu = null;
    else if (/\b(x86_64|amd64|x64|Win64|WOW64)\b/i.test(evidence)) cpu = 'x64';
  }
  if (bitness === '32') cpu = null;

  if (/Mac/i.test(`${os} ${ua}`)) return cpu === 'arm64' ? 'mac' : null;
  if (/Win/i.test(`${os} ${ua}`)) return cpu === 'x64' ? 'windows' : null;
  if (/Linux/i.test(`${os} ${ua}`)) return cpu === 'x64' ? 'linux' : cpu === 'arm64' ? 'linuxArm' : null;
  return null;
}

const platformLabels = {
  mac: 'macOS · Apple Silicon',
  windows: 'Windows · x64',
  linux: 'Linux · x64',
  linuxArm: 'Linux · ARM64',
  android: 'Android APK',
  ios: 'iOS · TestFlight',
};
const platformIcons = { mac: 'apple', windows: 'windows', linux: 'linux', linuxArm: 'linux', android: 'android', ios: 'apple' };

/** Enhance the build-time snapshot. Request failure leaves its links and version intact. */
export async function initializeDownloads(doc, nav, fetchRelease) {
  const section = doc.querySelector('#downloads');
  if (!section) return;
  let current = snapshot;
  let platform = detectPlatform(nav);
  const primaryButtons = [...doc.querySelectorAll('a[data-download-primary]')];
  const originalIcons = primaryButtons.map((button) => button.querySelector('[data-download-icon]')?.getAttribute('href'));
  const updatePrimary = () => {
    const href = platform && current.targets[platform];
    for (const [index, button] of primaryButtons.entries()) {
      button.setAttribute('href', href || '#downloads');
      const label = button.querySelector('[data-download-label]');
      if (label) label.textContent = href
        ? `${section.dataset.downloadLabel} ${platformLabels[platform]}`
        : section.dataset.chooseLabel;
      const icon = button.querySelector('[data-download-icon]');
      const iconHref = href ? `#icon-${platformIcons[platform]}` : originalIcons[index];
      if (icon && iconHref) icon.setAttribute('href', iconHref);
    }
  };
  updatePrimary();

  const enrichPlatform = async () => {
    try {
      const hints = await nav.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness', 'platform']);
      if (hints) {
        platform = detectPlatform(nav, hints);
        updatePrimary();
      }
    } catch {
      // High-entropy hints are optional; unsupported/denied hints retain manual choice.
    }
  };
  const refreshRelease = async () => {
    let next;
    try {
      const response = await fetchRelease(releaseEndpoint, { headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) return;
      next = resolveRelease(await response.json());
    } catch {
      return;
    }
    if (!next) return;
    current = next;
    for (const anchor of section.querySelectorAll('a[data-platform]')) {
      const href = current.targets[anchor.dataset.platform];
      anchor.hidden = !href;
      if (href) anchor.setAttribute('href', href);
      else anchor.removeAttribute('href');
    }
    const hasInstallers = ['mac', 'windows', 'linux', 'linuxArm', 'android'].some((key) => current.targets[key]);
    for (const message of section.querySelectorAll('[data-no-downloads]')) message.hidden = hasInstallers;
    for (const version of doc.querySelectorAll('[data-release-version]')) {
      version.textContent = `${current.version}${current.prerelease ? ' Beta' : ''}`;
    }
    updatePrimary();
  };
  await Promise.all([enrichPlatform(), refreshRelease()]);
}

if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  void initializeDownloads(document, navigator, (...args) => fetch(...args));
}
