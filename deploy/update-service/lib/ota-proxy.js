/**
 * EdgeOne edge proxy for allowlisted Vercel-origin assets.
 *
 * EdgeOne Pages deploys this project from git, while OTA snapshots (channel
 * manifests + content-addressed bundles) and the authoritative CHANGELOG are
 * published by CI to the Vercel origin only. To keep the EdgeOne host
 * (preferred by mainland-China clients) from serving stale seeds,
 * `/ota/channels/*.json`, `/ota/bundles/*.zip`, and `/CHANGELOG.md` are
 * reverse-proxied to the Vercel origin with edge-friendly cache headers.
 *
 * The proxy is strictly allowlisted — it never becomes an open proxy — and it
 * never fabricates success: upstream failures surface as 502, misses as 404.
 *
 * Bundle paths forward client `Range` so Capgo native resume works. Partial
 * responses (request Range or upstream 206/416) use `cache-control: no-store`
 * so edge caches never store a byte-range body that would poison later GETs.
 * Channel manifests and CHANGELOG never forward Range.
 */

const DEFAULT_UPSTREAM_ORIGIN = 'https://openchamber-update.vercel.app';
const UPSTREAM_TIMEOUT_MS = 20_000;

// Content-addressed, immutable artifacts — safe for long edge caching.
const BUNDLE_PATH_PATTERN = /^\/ota\/bundles\/[0-9a-f]{16}\.zip$/;
// Channel manifests mutate per release — short edge TTL keeps rollout/pause
// actions visible within a minute while shielding the origin from hot checks.
const CHANNEL_PATH_PATTERN = /^\/ota\/channels\/[a-z0-9_-]+\.json$/;
// Exact CHANGELOG path only — mutates per release; same short edge TTL as channels.
const CHANGELOG_PATH_PATTERN = /^\/CHANGELOG\.md$/;

const CHANNEL_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const BUNDLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function notFound() {
  return new Response('Not found', { status: 404 });
}

function upstreamUnavailable() {
  // Never masquerade an origin failure as an authoritative empty result.
  return new Response(JSON.stringify({ error: 'ota_upstream_unavailable' }), {
    status: 502,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Handle an allowlisted proxy request (`/ota/*` or `/CHANGELOG.md`) by
 * forwarding to the Vercel origin. Returns a `Response`; never throws.
 */
export async function handleOtaProxyRequest(request, options = {}) {
  const origin = options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN;
  const fetchImpl = options.fetchImpl ?? fetch;

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFound();

  const path = new URL(request.url).pathname;
  const isBundle = BUNDLE_PATH_PATTERN.test(path);
  const isChannelOrChangelog = CHANNEL_PATH_PATTERN.test(path) || CHANGELOG_PATH_PATTERN.test(path);
  if (!isBundle && !isChannelOrChangelog) return notFound();

  const clientRange = isBundle ? request.headers.get('range') : null;
  const upstreamHeaders = { Accept: '*/*' };
  if (clientRange) upstreamHeaders.Range = clientRange;

  let upstream;
  let upstreamError = 'unknown';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    upstream = await fetchImpl(origin + path, {
      method,
      headers: upstreamHeaders,
      signal: controller.signal,
    });
  } catch (error) {
    upstreamError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // Never masquerade an origin failure as an authoritative empty result.
    // Include the failure reason so edge/origin reachability issues are
    // diagnosable from the response alone.
    return new Response(JSON.stringify({ error: 'ota_upstream_unavailable', detail: upstreamError }), {
      status: 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    // Preserve misses (404), Range unsatisfiable (416), and origin errors without caching them.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const isPartialResponse = Boolean(clientRange) || upstream.status === 206;
  const headers = new Headers();
  headers.set(
    'cache-control',
    isPartialResponse ? 'no-store' : (isBundle ? BUNDLE_CACHE_CONTROL : CHANNEL_CACHE_CONTROL),
  );
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('content-length', contentLength);
  if (isBundle) {
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers.set('content-range', contentRange);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) headers.set('accept-ranges', acceptRanges);
  }
  headers.set('x-ota-proxy', 'edgeone');

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
