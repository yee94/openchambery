import { handleOtaProxyRequest } from '../lib/ota-proxy.js';

// Exact `/CHANGELOG.md` route. Static assets shadow functions on EdgeOne, so
// the EdgeOne build must NOT emit `public`/`dist` CHANGELOG.md (see
// YURI_UPDATE_SKIP_CHANGELOG_COPY in scripts/build.mjs).
export async function onRequest({ request, env }) {
  return handleOtaProxyRequest(request, { upstreamOrigin: env?.YURI_OTA_UPSTREAM_ORIGIN });
}
