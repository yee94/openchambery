/**
 * Host OAuth browser launcher — Cap provider OAuth spirit.
 * iOS inject point: ASWebAuthenticationSession (callbackURLScheme = openchamber).
 * Android inject point: Custom Tabs (androidx.browser) + intent result.
 * Without host → unavailable (never invent in-Lynx WebView OAuth / Capgo).
 *
 * Wire with `startLynxProviderOAuth` → open authorize URL →
 * `completeLynxProviderOAuth` with optional user code / redirect.
 */
export type LynxOAuthBrowserOpenInput = {
  url: string;
  /** iOS ASWebAuthenticationSession callback scheme; default openchamber. */
  callbackScheme?: string;
  /** Prefer ephemeral session (iOS prefersEphemeralWebBrowserSession). */
  prefersEphemeral?: boolean;
};

export type LynxOAuthBrowserOpenResult =
  | { status: 'ok'; callbackUrl?: string; cancelled?: boolean }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: 'no-host' }
  | { status: 'failed'; error: string };

export type LynxOAuthBrowserBinder = {
  openAuthorize: (input: LynxOAuthBrowserOpenInput) => Promise<LynxOAuthBrowserOpenResult>;
};

export type LynxOAuthBrowserAdapter = {
  inject: (binder: LynxOAuthBrowserBinder | null) => void;
  isAvailable: () => boolean;
  openAuthorize: (input: LynxOAuthBrowserOpenInput) => Promise<LynxOAuthBrowserOpenResult>;
};

export const LYNX_OAUTH_CALLBACK_SCHEME = 'openchamber';

export const LYNX_OAUTH_BROWSER_INJECT_POINTS = [
  'iOS: ASWebAuthenticationSession(url:callbackURLScheme:) — presentationContextProvider = host window.',
  'iOS: prefersEphemeralWebBrowserSession = true when input.prefersEphemeral.',
  'Android: CustomTabsIntent.Builder().build().launchUrl(activity, uri).',
  'Android: listen for openchamber:// OAuth redirect via intent-filter; resume Lynx with callbackUrl.',
  'Do not embed WKWebView / WebView OAuth; do not use Capgo channels for Lynx.',
] as const;

export const createLynxOAuthBrowserAdapter = (): LynxOAuthBrowserAdapter => {
  let binder: LynxOAuthBrowserBinder | null = null;
  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    openAuthorize: async (input) => {
      const url = input.url.trim();
      if (!url) return { status: 'failed', error: 'authorize url required' };
      if (!binder) return { status: 'unavailable', reason: 'no-host' };
      try {
        return await binder.openAuthorize({
          ...input,
          url,
          callbackScheme: input.callbackScheme || LYNX_OAUTH_CALLBACK_SCHEME,
        });
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
