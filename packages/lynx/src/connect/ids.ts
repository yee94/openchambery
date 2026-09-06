import { LYNX_DEVICE_ID_STORAGE_KEY } from './types.ts';
import type { LynxJsonStore } from '../host/adapters.ts';

export const createLynxId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `lynx_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
};

export const readOrCreateDeviceId = (store: LynxJsonStore, createId: () => string): string => {
  const existing = store.read(LYNX_DEVICE_ID_STORAGE_KEY);
  if (existing && existing.trim()) return existing.trim();
  const generated = createId();
  store.write(LYNX_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
};

export const mobileClientDedupeKey = (deviceId: string): string => `mobile:${deviceId}`;

