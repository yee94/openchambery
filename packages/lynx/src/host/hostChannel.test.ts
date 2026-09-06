import { describe, expect, test } from 'vitest';

import { createLynxCameraAdapter } from './camera';
import { createLynxHostChannel, LYNX_HOST_CHANNEL_METHODS } from './hostChannel';
import { createLynxOAuthBrowserAdapter } from './oauthBrowser';

describe('Lynx host message channel', () => {
  test('documents Cap-plugin method names', () => {
    expect(LYNX_HOST_CHANNEL_METHODS).toContain('scanPairingQr');
    expect(LYNX_HOST_CHANNEL_METHODS).toContain('openOAuthAuthorize');
    expect(LYNX_HOST_CHANNEL_METHODS).toContain('secureStore');
  });

  test('scanPairingQr via camera adapter emits qrScanResult', async () => {
    const camera = createLynxCameraAdapter();
    camera.inject({
      scanPairingQr: async () => ({ status: 'ok', rawValue: 'http://127.0.0.1:4096' }),
    });
    const channel = createLynxHostChannel({ adapters: { camera } });
    const events: string[] = [];
    channel.subscribe((e) => events.push(e.type));
    await channel.scanPairingQr();
    expect(events).toEqual(['qrScanResult']);
  });

  test('openOAuthAuthorize via oauth adapter emits oauthCallback', async () => {
    const oauthBrowser = createLynxOAuthBrowserAdapter();
    oauthBrowser.inject({
      openAuthorize: async () => ({ status: 'ok', callbackUrl: 'openchamber://oauth?code=x' }),
    });
    const channel = createLynxHostChannel({ adapters: { oauthBrowser } });
    const events: string[] = [];
    channel.subscribe((e) => {
      if (e.type === 'oauthCallback') events.push(e.callbackUrl);
    });
    await channel.openOAuthAuthorize({ url: 'https://auth.example/authorize' });
    expect(events).toEqual(['openchamber://oauth?code=x']);
  });
});
