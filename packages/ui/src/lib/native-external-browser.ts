import { registerPlugin } from '@capacitor/core';

export const YuriExternalBrowser = registerPlugin<{
  open(options: { url: string }): Promise<void>;
}>('YuriExternalBrowser');
