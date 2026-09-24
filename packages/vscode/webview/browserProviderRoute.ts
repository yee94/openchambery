/**
 * VS Code has no browser-provider host. These paths must not fall through to
 * the OpenCode proxy, and must not look like an empty successful catalog.
 */

export const BROWSER_PROVIDER_ROUTE_PREFIX = '/api/browser-providers';

export const isBrowserProviderRoute = (pathname: string): boolean => {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return normalized === BROWSER_PROVIDER_ROUTE_PREFIX
    || normalized.startsWith(`${BROWSER_PROVIDER_ROUTE_PREFIX}/`);
};

export const browserProviderUnsupportedBody = () => ({
  ok: false,
  code: 'UNSUPPORTED',
  error: 'Browser providers are not available in VS Code. No browser action was run.',
});
