import { registerPlugin } from '@capacitor/core';

export const OpenChamberExternalBrowser = registerPlugin<{
  open(options: { url: string }): Promise<void>;
}>('OpenChamberExternalBrowser');
