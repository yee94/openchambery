import { registerPlugin } from '@capacitor/core';
import { isCapacitorApp } from '@/lib/platform';
import { MobileUpdatesUnsupportedError, type MobileUpdateChannel } from './types';

const nativeConfig = registerPlugin<{
  getConfiguration(): Promise<{ channel?: unknown; shellApiVersion?: unknown }>;
}>('YuriUpdateConfig');

/** Installed-shell metadata, never values supplied by the running OTA bundle. */
export async function readNativeUpdateConfig(): Promise<{ channel: MobileUpdateChannel; shellApiVersion: number }> {
  if (!isCapacitorApp()) throw new MobileUpdatesUnsupportedError();
  const config = await nativeConfig.getConfiguration();
  if ((config.channel !== 'stable' && config.channel !== 'beta')
    || typeof config.shellApiVersion !== 'number'
    || !Number.isInteger(config.shellApiVersion) || config.shellApiVersion < 1) {
    throw new Error('Invalid native update configuration');
  }
  return { channel: config.channel, shellApiVersion: config.shellApiVersion };
}
