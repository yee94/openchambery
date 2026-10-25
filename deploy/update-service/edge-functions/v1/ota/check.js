import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

// /ota/* on EdgeOne is served by the reverse-proxy function; loading manifests
// relative to this host would loop back into the edge runtime. Read the
// authoritative Vercel origin instead (bundle URLs in the response stay
// relative to the client-facing request origin).
export async function onRequest({ request, env }) {
  if (!env?.YURI_OTA_UPSTREAM_ORIGIN) return new Response('Yuri update origin is not configured', { status: 503 });
  return handleCapgoOtaCheck(request, { manifestBaseUrl: env.YURI_OTA_UPSTREAM_ORIGIN });
}
