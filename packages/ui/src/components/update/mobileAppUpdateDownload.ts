import { Capacitor } from '@capacitor/core';

import { openExternalUrl } from '@/lib/url';
import { YuriExternalBrowser } from '@/lib/native-external-browser';

type MobileAppUpdateDownloadDependencies = {
  getPlatform: () => string;
  isPluginAvailable: (name: string) => boolean;
  openInSystemBrowser: (options: { url: string }) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
};

const defaultDependencies: MobileAppUpdateDownloadDependencies = {
  getPlatform: () => Capacitor.getPlatform(),
  isPluginAvailable: (name) => Capacitor.isPluginAvailable(name),
  openInSystemBrowser: (options) => YuriExternalBrowser.open(options),
  openExternal: openExternalUrl,
};

export const openMobileAppUpdateDownload = async (
  url: string,
  dependencies: MobileAppUpdateDownloadDependencies = defaultDependencies,
): Promise<boolean> => {
  if (dependencies.getPlatform() === 'android') {
    if (!dependencies.isPluginAvailable('YuriExternalBrowser')) {
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
