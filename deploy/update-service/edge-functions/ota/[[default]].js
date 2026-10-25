import { handleOtaProxyRequest } from '../../lib/ota-proxy.js';

// EdgeOne multi-level dynamic route: matches /ota/* (channels + bundles).
// `/CHANGELOG.md` is a sibling edge function (`edge-functions/CHANGELOG.md.js`);
// this route cannot match it. Static assets shadow functions on EdgeOne, so
// the EdgeOne build must NOT copy the `ota/` seed tree into its output
// directory (see scripts/build.mjs).
export async function onRequest({ request, env }) {
  return handleOtaProxyRequest(request, { upstreamOrigin: env?.YURI_OTA_UPSTREAM_ORIGIN });
}
