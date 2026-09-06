import { describe, expect, test } from 'vitest';

import {
  createLynxOAuthBrowserAdapter,
  LYNX_OAUTH_BROWSER_INJECT_POINTS,
  LYNX_OAUTH_CALLBACK_SCHEME,
} from './oauthBrowser';

describe('Lynx OAuth browser adapter', () => {
  test('no host → unavailable (never invent WebView OAuth)', async () => {
    const adapter = createLynxOAuthBrowserAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.openAuthorize({ url: 'https://auth.example/authorize' })).toEqual({
      status: 'unavailable',
      reason: 'no-host',
    });
  });

  test('host returns callback URL; empty url fails', async () => {
    const adapter = createLynxOAuthBrowserAdapter();
    expect(await adapter.openAuthorize({ url: '  ' })).toEqual({
      status: 'failed',
      error: 'authorize url required',
    });
    adapter.inject({
      openAuthorize: async (input) => ({
        status: 'ok',
        callbackUrl: `${input.callbackScheme}://oauth?code=1`,
      }),
    });
    const result = await adapter.openAuthorize({ url: 'https://auth.example/authorize' });
    expect(result).toEqual({
      status: 'ok',
      callbackUrl: `${LYNX_OAUTH_CALLBACK_SCHEME}://oauth?code=1`,
    });
    expect(LYNX_OAUTH_BROWSER_INJECT_POINTS[0]).toContain('ASWebAuthenticationSession');
  });
});
