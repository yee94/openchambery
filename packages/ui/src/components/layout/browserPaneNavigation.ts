/**
 * Normalize a browser address-bar / targetPath value to an http(s) URL, or about:blank.
 */
export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'about:blank';
    return parsed.toString();
  } catch {
    return 'about:blank';
  }
};

/**
 * When the parent tab targetPath changes (same browser tab id), decide whether the
 * pane should navigate. Returns the next URL, or null when no external navigation
 * is needed (empty incoming, or already on that URL).
 */
export const resolveBrowserPaneNavigation = (
  incomingUrl: string,
  currentUrl: string,
): string | null => {
  const normalized = normalizeBrowserUrl(incomingUrl);
  const nextUrl = normalized !== 'about:blank' ? normalized : '';
  if (!nextUrl) return null;
  if (nextUrl === currentUrl) return null;
  return nextUrl;
};

/**
 * Electron LAN/direct keeps the native `<webview>` Desktop Browser.
 * Electron + Relay must use the iframe Host preview proxy (loopback gateway),
 * never client-side `loadURL` of the user's localhost.
 */
export const shouldUseDesktopWebviewBrowser = (input: {
  isElectron: boolean;
  relayActive: boolean;
}): boolean => Boolean(input.isElectron) && !input.relayActive;
