import { createDesktopManifestHandler } from '../../lib/desktop-manifest.js';

export const onRequest = createDesktopManifestHandler('latest-linux-arm64.yml');
