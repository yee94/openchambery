import { pathToFileURL } from 'node:url';

export function verifyReleaseUpdateEnv(env) {
  const expectedPaths = {
    YURI_UPDATE_ORIGIN: '/',
    YURI_OTA_UPDATE_URL: '/v1/ota/check',
    VITE_YURI_EDGEONE_UPDATE_CHECK_URL: '/v1/update/check',
    VITE_YURI_VERCEL_UPDATE_CHECK_URL: '/v1/update/check',
    VITE_YURI_EDGEONE_OTA_CHECK_URL: '/v1/mobile/update/check',
    VITE_YURI_VERCEL_OTA_CHECK_URL: '/v1/mobile/update/check',
  };
  const urls = {};
  for (const [name, pathname] of Object.entries(expectedPaths)) {
    let url;
    try { url = new URL(env[name]); } catch { throw new Error(`${name} must be configured before building release assets.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== pathname
      || url.hostname.endsWith('.invalid') || url.hostname === 'localhost') {
      throw new Error(`${name} must be a verified HTTPS endpoint with path ${pathname}.`);
    }
    urls[name] = url;
  }
  const mirror = urls.YURI_UPDATE_ORIGIN.origin;
  const origin = urls.VITE_YURI_VERCEL_OTA_CHECK_URL.origin;
  if (mirror === origin || urls.VITE_YURI_VERCEL_UPDATE_CHECK_URL.origin !== origin
    || ['YURI_OTA_UPDATE_URL', 'VITE_YURI_EDGEONE_UPDATE_CHECK_URL', 'VITE_YURI_EDGEONE_OTA_CHECK_URL'].some(name => urls[name].origin !== mirror)) {
    throw new Error('Native and web update URLs must use the same distinct Vercel origin and EdgeOne mirror.');
  }
  return { origin, mirror };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { origin, mirror } = verifyReleaseUpdateEnv(process.env);
  console.log(`Release update endpoints: origin=${origin}, mirror=${mirror}`);
}
