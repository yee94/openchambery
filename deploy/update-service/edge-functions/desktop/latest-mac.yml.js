import { createDesktopManifestHandler } from '../desktop-manifest.js';

export const onRequest = createDesktopManifestHandler('latest-mac.yml');
