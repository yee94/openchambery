import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

// /ota/* and /CHANGELOG.md on EdgeOne are reverse-proxied (CHANGELOG may still
// be a shadowed git-time static file). Loading either relative to this host
// would loop the edge runtime or attach empty releaseNotes. Read the
// authoritative Vercel origin instead (bundle URLs in the response stay
// relative to the client-facing request origin).
export async function onRequest({ request, env }) {
  if (!env?.YURI_OTA_UPSTREAM_ORIGIN) return new Response('Yuri update origin is not configured', { status: 503 });
  return handleMobileUpdateCheck(request, { manifestBaseUrl: env.YURI_OTA_UPSTREAM_ORIGIN });
}
