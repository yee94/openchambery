const GITHUB_RELEASE_DOWNLOAD_BASE = 'https://github.com/yee94/openchamber/releases/latest/download/';

const rewriteRelativeAssetUrls = (manifest) => manifest.replace(
  /^(\s*(?:url|path):\s*)(["']?)([^\s"'#]+)\2(\s*(?:#.*)?)$/gm,
  (line, prefix, quote, asset, suffix) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset)) return line;
    return `${prefix}${quote}${GITHUB_RELEASE_DOWNLOAD_BASE}${asset}${quote}${suffix}`;
  },
);

export const createDesktopManifestHandler = (filename, fetchImpl = fetch) => async () => {
  const response = await fetchImpl(`${GITHUB_RELEASE_DOWNLOAD_BASE}${filename}`, {
    headers: { Accept: 'application/x-yaml, text/yaml, text/plain;q=0.9' },
  });
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
