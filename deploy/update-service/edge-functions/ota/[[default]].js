import { handleOtaProxyRequest } from '../../lib/ota-proxy.js';

// EdgeOne multi-level dynamic route: matches /ota/* (channels + bundles).
// Static assets shadow functions on EdgeOne, so the EdgeOne build must NOT
// copy the `ota/` seed tree into its output directory (see scripts/build.mjs).
export async function onRequest({ request }) {
  return handleOtaProxyRequest(request);
}
