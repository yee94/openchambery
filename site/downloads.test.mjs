import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { detectPlatform, initializeDownloads, resolveRelease, snapshot } from './assets/downloads.mjs';

const release = (version, prerelease, assets = [], published_at = '2026-10-01T00:00:00Z') => ({
  tag_name: `v${version}`, prerelease, assets, published_at,
});
const asset = (version, suffix) => {
  const name = suffix === 'app-release.apk' ? suffix : `Yuri-${version}-${suffix}`;
  return { name, browser_download_url: `https://github.com/yee94/yuri/releases/download/v${version}/${name}` };
};
const page = () => {
  const window = new Window();
  const doc = window.document;
  doc.body.innerHTML = `
    <a data-download-primary href="#downloads"><svg><use data-download-icon href="#icon-download"></use></svg><span data-download-label>Choose installer</span></a>
    <section id="downloads" data-download-label="Download" data-choose-label="Choose installer">
      <span data-release-version>0.1.1-beta.1 Beta</span>
      ${Object.entries(snapshot.targets).map(([key, href]) => `<a data-platform="${key}" href="${href}">${key}</a>`).join('')}
      <p data-no-downloads hidden>No installers</p>
    </section>`;
  return doc;
};
const windows = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' };

describe('release selection', () => {
  it('prefers stable releases, then the newest publication, without mixing assets', () => {
    const result = resolveRelease([
      release('2.0.0-beta.1', true, [asset('2.0.0-beta.1', 'win-x64.exe')], '2026-10-25'),
      release('1.0.0', false, [asset('1.0.0', 'win-x64.exe')]),
      release('1.1.0', false, [asset('1.1.0', 'linux-arm64.AppImage')], '2026-10-20'),
    ]);
    expect(result.version).toBe('1.1.0');
    expect(result.prerelease).toBe(false);
    expect(result.targets.windows).toBeNull();
    expect(result.targets.linuxArm).toBe(asset('1.1.0', 'linux-arm64.AppImage').browser_download_url);
    expect(result.targets.ios).toBe(snapshot.targets.ios);
  });

  it('selects the newest beta when no stable release exists and ignores drafts', () => {
    const result = resolveRelease([
      { ...release('3.0.0', false), draft: true },
      release('2.0.0-beta.1', true),
      release('2.0.0-beta.2', true, [], '2026-10-20'),
    ]);
    expect(result).toMatchObject({ version: '2.0.0-beta.2', prerelease: true });
    expect(resolveRelease([])).toBeNull();
    expect(() => resolveRelease({ message: 'rate limited' })).toThrow();
  });

  it('accepts only real matching-release GitHub asset URLs', () => {
    const result = resolveRelease([release('1.0.0', false, [
      { ...asset('1.0.0', 'win-x64.exe'), browser_download_url: snapshot.targets.windows },
      { ...asset('1.0.0', 'mac-arm64.dmg'), browser_download_url: 'javascript:alert(1)' },
      asset('1.0.0', 'app-release.apk'),
    ])]);
    expect(result.targets.windows).toBeNull();
    expect(result.targets.mac).toBeNull();
    expect(result.targets.android).toBe(asset('1.0.0', 'app-release.apk').browser_download_url);
  });
});

describe('safe platform detection', () => {
  it('prioritizes mobile including desktop-mode iPadOS', () => {
    expect(detectPlatform({ userAgent: 'Macintosh; Intel Mac OS X', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios');
    expect(detectPlatform({ userAgent: 'iPhone; CPU iPhone OS 18' })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Linux; Android 15; arm64', platform: 'Linux aarch64' })).toBe('android');
  });

  it('requires architecture evidence and uses high-entropy hints over reduced UAs', () => {
    const mac = { userAgent: 'Macintosh; Intel Mac OS X', platform: 'MacIntel' };
    expect(detectPlatform(mac)).toBeNull();
    expect(detectPlatform(mac, { architecture: 'arm', bitness: '64' })).toBe('mac');
    expect(detectPlatform(mac, { architecture: 'x86', bitness: '64' })).toBeNull();
    expect(detectPlatform(windows)).toBe('windows');
    expect(detectPlatform(windows, { architecture: 'arm', bitness: '64' })).toBeNull();
    expect(detectPlatform(windows, { architecture: 'x86', bitness: '32' })).toBeNull();
    expect(detectPlatform(windows, { bitness: '32' })).toBeNull();
    expect(detectPlatform({ platform: 'Win32' })).toBeNull();
    expect(detectPlatform({ platform: 'Linux' })).toBeNull();
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('linux');
    expect(detectPlatform({ platform: 'Linux aarch64' })).toBe('linuxArm');
    expect(detectPlatform({ platform: 'Linux armv7l' })).toBeNull();
    expect(detectPlatform({})).toBeNull();
  });
});

describe('download page enhancement', () => {
  it('preserves HTML links/version on network, HTTP and payload failures', async () => {
    const failures = [
      async () => { throw new Error('offline'); },
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({ message: 'invalid' }) }),
    ];
    for (const fetchRelease of failures) {
      const doc = page();
      const before = doc.querySelector('#downloads').innerHTML;
      await initializeDownloads(doc, windows, fetchRelease);
      expect(doc.querySelector('#downloads').innerHTML).toBe(before);
      expect(doc.querySelector('[data-download-primary]').href).toBe(snapshot.targets.windows);
      expect(doc.querySelector('[data-download-label]').textContent).toBe('Download Windows · x64');
    }
  });

  it('updates links/version/icons, hides missing assets and keeps iOS when no installers remain', async () => {
    const doc = page();
    await initializeDownloads(doc, windows, async () => ({
      ok: true, json: async () => [release('1.0.0', false, [asset('1.0.0', 'win-x64.exe')])],
    }));
    expect(doc.querySelector('[data-platform="mac"]').hidden).toBe(true);
    expect(doc.querySelector('[data-platform="mac"]').hasAttribute('href')).toBe(false);
    expect(doc.querySelector('[data-download-icon]').getAttribute('href')).toBe('#icon-windows');
    expect(doc.querySelector('[data-release-version]').textContent).toBe('1.0.0');
    expect(doc.querySelector('[data-no-downloads]').hidden).toBe(true);

    const empty = page();
    await initializeDownloads(empty, windows, async () => ({ ok: true, json: async () => [release('1.1.0-beta.1', true)] }));
    expect(empty.querySelector('[data-download-primary]').getAttribute('href')).toBe('#downloads');
    expect(empty.querySelector('[data-download-label]').textContent).toBe('Choose installer');
    expect(empty.querySelector('[data-no-downloads]').hidden).toBe(false);
    expect(empty.querySelector('[data-platform="ios"]').hidden).toBe(false);
    expect(empty.querySelector('[data-release-version]').textContent).toBe('1.1.0-beta.1 Beta');
  });

  it('coordinates delayed CPU hints with the currently selected release', async () => {
    const doc = page();
    let resolveHints;
    const hints = new Promise((resolve) => { resolveHints = resolve; });
    const nav = { platform: 'MacIntel', userAgentData: { getHighEntropyValues: () => hints } };
    const done = initializeDownloads(doc, nav, async () => ({
      ok: true, json: async () => [release('1.0.0', false, [asset('1.0.0', 'mac-arm64.dmg')])],
    }));
    expect(doc.querySelector('[data-download-primary]').getAttribute('href')).toBe('#downloads');
    resolveHints({ architecture: 'arm', bitness: '64' });
    await done;
    expect(doc.querySelector('[data-download-primary]').href).toBe(asset('1.0.0', 'mac-arm64.dmg').browser_download_url);
    expect(doc.querySelector('[data-download-icon]').getAttribute('href')).toBe('#icon-apple');
  });
});
