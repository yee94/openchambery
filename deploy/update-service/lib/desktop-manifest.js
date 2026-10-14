const GITHUB_RELEASE_DOWNLOAD_BASE = 'https://github.com/yee94/openchamber/releases/latest/download/';

/** electron-updater 6 generic feed names used by 2.0.0 and earlier packaged clients. */
const LEGACY_FEED_UPSTREAM = {
  'latest.yml': 'full.yml',
  'latest-mac.yml': 'full-mac.yml',
  'latest-linux.yml': 'full-linux.yml',
  'latest-linux-arm64.yml': 'full-linux-arm64.yml',
};

const FEED_HEADERS = { Accept: 'application/x-yaml, text/yaml, text/plain;q=0.9, application/json;q=0.8' };

const rewriteRelativeAssetUrls = (manifest) => manifest.replace(
  /^(\s*(?:-\s+)?(?:"(?:url|path)"|(?:url|path)):\s*)(["']?)([^\s"'#,]+)\2(,?)(\s*(?:#.*)?)$/gm,
  (line, prefix, quote, asset, comma, suffix) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset)) return line;
    return `${prefix}${quote}${GITHUB_RELEASE_DOWNLOAD_BASE}${asset}${quote}${comma}${suffix}`;
  },
);

const fetchFeed = (filename, fetchImpl) => fetchImpl(`${GITHUB_RELEASE_DOWNLOAD_BASE}${filename}`, {
  headers: FEED_HEADERS,
});

export const createDesktopManifestHandler = (filename, fetchImpl = fetch) => async () => {
  const currentFeed = LEGACY_FEED_UPSTREAM[filename];
  let response = await fetchFeed(currentFeed ?? filename, fetchImpl);
  // A GitHub Latest that still published electron-builder's latest*.yml must keep working
  // until the first full*.yml stable release. Only a missing current feed falls back.
  if (response.status === 404 && currentFeed) {
    response = await fetchFeed(filename, fetchImpl);
  }
  if (!response.ok) {
    return new Response('Update manifest is unavailable', { status: response.status });
  }

  return new Response(rewriteRelativeAssetUrls(await response.text()), {
    status: 200,
    headers: {
      'content-type': 'application/x-yaml; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
};

export { rewriteRelativeAssetUrls };
