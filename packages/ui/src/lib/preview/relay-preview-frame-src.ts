/**
 * Resolve the iframe `src` for Host loopback preview.
 *
 * Direct / LAN: keep the authenticated asset URL (same-origin or runtime API
 * origin). Relay + Electron loopback gateway: rewrite onto
 * `http://127.0.0.1:<port>` so Chromium can load HTML/static assets while the
 * owner renderer still `runtimeFetch`es the same path through the tunnel.
 */

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const PREVIEW_PROXY_PATH_PREFIX = '/api/preview/proxy/';

/**
 * WHATWG-normalize a request path and require it stay under the preview proxy
 * prefix. Rejects `/api/preview/proxy/../session` and `%2e%2e` after decode.
 */
export const isNormalizedPreviewProxyPath = (pathWithOptionalQuery: string): boolean => {
  if (typeof pathWithOptionalQuery !== 'string' || !pathWithOptionalQuery) return false;
  const pathOnly = pathWithOptionalQuery.split('?', 1)[0] || '';
  if (pathOnly.includes('\\') || pathOnly.includes('\0')) return false;
  try {
    const parsed = new URL(pathOnly, 'http://127.0.0.1');
    if (parsed.hostname !== '127.0.0.1') return false;
    return parsed.pathname.startsWith(PREVIEW_PROXY_PATH_PREFIX);
  } catch {
    return false;
  }
};

export type ResolveRelayPreviewFrameSrcInput = {
  relayActive: boolean;
  /** Loopback gateway origin from desktop `previewGateway.ensure()`, e.g. http://127.0.0.1:54321 */
  gatewayOrigin: string | null | undefined;
  /** Result of `authenticatedAsset('/api/preview/proxy/...')` (relative or absolute). */
  authenticatedAssetUrl: string;
};

/**
 * When relay is active and a gateway origin is ready, map the authenticated
 * preview proxy URL onto the gateway origin (path + query tokens + hash).
 * Otherwise return `authenticatedAssetUrl` unchanged.
 */
export const resolveRelayPreviewFrameSrc = (
  input: ResolveRelayPreviewFrameSrcInput,
): string => {
  const authenticatedAssetUrl = typeof input.authenticatedAssetUrl === 'string'
    ? input.authenticatedAssetUrl
    : '';
  if (!authenticatedAssetUrl) return '';

  if (!input.relayActive) {
    return authenticatedAssetUrl;
  }

  const gatewayOrigin = typeof input.gatewayOrigin === 'string'
    ? input.gatewayOrigin.trim()
    : '';
  if (!gatewayOrigin) {
    return authenticatedAssetUrl;
  }

  try {
    const gateway = new URL(gatewayOrigin);
    if (gateway.protocol !== 'http:' && gateway.protocol !== 'https:') {
      return authenticatedAssetUrl;
    }
    // Gateway must stay on loopback — never rewrite onto a non-local origin.
    if (gateway.hostname !== '127.0.0.1' && gateway.hostname !== 'localhost') {
      return authenticatedAssetUrl;
    }

    const asset = ABSOLUTE_URL_PATTERN.test(authenticatedAssetUrl)
      ? new URL(authenticatedAssetUrl)
      : new URL(authenticatedAssetUrl, 'http://openchamber.local');

    if (!asset.pathname.startsWith(PREVIEW_PROXY_PATH_PREFIX)) {
      return authenticatedAssetUrl;
    }

    return `${gateway.origin}${asset.pathname}${asset.search}${asset.hash}`;
  } catch {
    return authenticatedAssetUrl;
  }
};
