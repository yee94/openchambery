import { Capacitor, registerPlugin } from '@capacitor/core';

import { openExternalUrl } from '@/lib/url';

type OpenChamberExternalBrowserPlugin = {
  open(options: { url: string }): Promise<void>;
};

type MobileAppUpdateDownloadDependencies = {
  getPlatform: () => string;
  isPluginAvailable: (name: string) => boolean;
  openInSystemBrowser: (options: { url: string }) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
};

const OpenChamberExternalBrowser = registerPlugin<OpenChamberExternalBrowserPlugin>('OpenChamberExternalBrowser');

const defaultDependencies: MobileAppUpdateDownloadDependencies = {
  getPlatform: () => Capacitor.getPlatform(),
  isPluginAvailable: (name) => Capacitor.isPluginAvailable(name),
  openInSystemBrowser: (options) => OpenChamberExternalBrowser.open(options),
  openExternal: openExternalUrl,
};

export const openMobileAppUpdateDownload = async (
  url: string,
  dependencies: MobileAppUpdateDownloadDependencies = defaultDependencies,
): Promise<boolean> => {
  if (dependencies.getPlatform() === 'android') {
    if (!dependencies.isPluginAvailable('OpenChamberExternalBrowser')) {
      return false;
    }

    try {
      await dependencies.openInSystemBrowser({ url });
      return true;
    } catch {
      return false;
    }
  }

  return dependencies.openExternal(url);
};
