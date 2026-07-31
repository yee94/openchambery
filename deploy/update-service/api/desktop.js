export const config = { runtime: 'edge' };

import { createDesktopManifestHandler } from '../lib/desktop-manifest.js';

const ALLOWED_MANIFESTS = new Set([
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
]);

export default async function handler(request) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');
  if (!file || !ALLOWED_MANIFESTS.has(file)) {
    return new Response('Not found', { status: 404 });
  }

  return createDesktopManifestHandler(file)();
}
