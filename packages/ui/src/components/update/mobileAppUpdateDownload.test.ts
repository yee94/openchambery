import { describe, expect, test } from 'bun:test';

import { openMobileAppUpdateDownload } from './mobileAppUpdateDownload';

const downloadUrl = 'https://example.com/OpenChamber.apk';

describe('openMobileAppUpdateDownload', () => {
  test('hands Android updates to the native system-browser plugin', async () => {
    const systemBrowserCalls: Array<{ url: string }> = [];
    let externalBrowserCalls = 0;

    const opened = await openMobileAppUpdateDownload(downloadUrl, {
      getPlatform: () => 'android',
      isPluginAvailable: () => true,
      openInSystemBrowser: async (options) => { systemBrowserCalls.push(options); },
      openExternal: async () => {
        externalBrowserCalls += 1;
        return true;
      },
    });

    expect(opened).toBe(true);
    expect(systemBrowserCalls).toEqual([{ url: downloadUrl }]);
    expect(externalBrowserCalls).toBe(0);
  });

  test('does not reopen Android updates in the WebView when the native browser plugin is unavailable', async () => {
    let externalBrowserCalls = 0;

    const opened = await openMobileAppUpdateDownload(downloadUrl, {
      getPlatform: () => 'android',
      isPluginAvailable: () => false,
      openInSystemBrowser: async () => undefined,
      openExternal: async () => {
        externalBrowserCalls += 1;
        return true;
      },
    });

    expect(opened).toBe(false);
    expect(externalBrowserCalls).toBe(0);
  });

  test('keeps the regular external launcher for other platforms', async () => {
    let systemBrowserCalls = 0;
    const opened = await openMobileAppUpdateDownload(downloadUrl, {
      getPlatform: () => 'ios',
      isPluginAvailable: () => true,
      openInSystemBrowser: async () => { systemBrowserCalls += 1; },
      openExternal: async (url) => url === downloadUrl,
    });

    expect(opened).toBe(true);
    expect(systemBrowserCalls).toBe(0);
  });
});
