import { createDesktopManifestHandler } from '../../lib/desktop-manifest.js';

export const onRequest = createDesktopManifestHandler('latest.yml');
