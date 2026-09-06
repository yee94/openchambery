/**
 * Cap OpenChamberExternalBrowser contract: http(s) only.
 * Uses expo-web-browser (in-app Safari/Chrome Custom Tabs), not Linking to arbitrary schemes.
 */

export class ExternalBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalBrowserError';
  }
}

export function assertHttpUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ExternalBrowserError('An http(s) URL is required.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ExternalBrowserError('An http(s) URL is required.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExternalBrowserError('An http(s) URL is required.');
  }
  if (!url.hostname) {
    throw new ExternalBrowserError('An http(s) URL is required.');
  }
  return url.toString();
}

export async function openExternalBrowser(raw: string): Promise<void> {
  const url = assertHttpUrl(raw);
  const WebBrowser = await import('expo-web-browser');
  await WebBrowser.openBrowserAsync(url);
}
