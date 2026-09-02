import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// /ota/* and /CHANGELOG.md on EdgeOne are reverse-proxied (CHANGELOG may still
// be a shadowed git-time static file). Loading either relative to this host
// would loop the edge runtime or attach empty releaseNotes. Read the
// authoritative Vercel origin instead (bundle URLs in the response stay
// relative to the client-facing request origin).
const MANIFEST_BASE_URL = 'https://openchamber-update.vercel.app';

export async function onRequest({ request }) {
  return handleMobileUpdateCheck(request, { manifestBaseUrl: MANIFEST_BASE_URL });
}
