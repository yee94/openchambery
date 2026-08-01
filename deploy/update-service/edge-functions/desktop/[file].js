import { createDesktopManifestHandler } from '../../lib/desktop-manifest.js';

const MANIFEST_FILENAMES = new Set([
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
]);

export async function onRequest({ request }) {
  const filename = new URL(request.url).pathname.split('/').at(-1);
  if (!MANIFEST_FILENAMES.has(filename)) {
    return new Response('Not found', { status: 404 });
  }

  return createDesktopManifestHandler(filename)();
}
