import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// /ota/* on EdgeOne is served by the reverse-proxy function; loading manifests
// relative to this host would loop back into the edge runtime. Read the
// authoritative Vercel origin instead (bundle URLs in the response stay
// relative to the client-facing request origin).
const MANIFEST_BASE_URL = 'https://openchamber-update.vercel.app';

export async function onRequest({ request }) {
  return handleMobileUpdateCheck(request, { manifestBaseUrl: MANIFEST_BASE_URL });
}
