import { Capacitor, registerPlugin } from '@capacitor/core';

import { isCapacitorApp } from '@/lib/platform';

export const NATIVE_MEDIA_PICK_LIMIT = 20;

type OpenChamberMediaPlugin = {
  pickMedia: (options: {
    limit?: number;
  }) => Promise<{
    cancelled: boolean;
    files: Array<{
      path: string;
      name: string;
      mimeType: string;
      size: number;
    }>;
  }>;
};

const OpenChamberMedia = registerPlugin<OpenChamberMediaPlugin>('OpenChamberMedia');

/**
 * True only on Capacitor Android when the OpenChamberMedia native picker is
 * registered. iOS keeps the WKWebView document/photo picker; web, desktop,
 * and VS Code never use this bridge.
 */
export function canUseNativeMediaPick(): boolean {
  return isCapacitorApp()
    && Capacitor.getPlatform() === 'android'
    && Capacitor.isPluginAvailable('OpenChamberMedia');
}

/**
 * Open the Android Photo Picker and materialize selected items as browser Files.
 *
 * Returns `null` when the native plugin is unavailable so the caller can fall
 * back to the WebView file input — that is not an error. A user cancel returns
 * an empty array. Bridge failures and per-file fetch failures throw so the UI
 * can toast; a failed file is never silently dropped into an empty result.
 */
export async function pickNativeMediaFiles(limit: number): Promise<File[] | null> {
  if (!canUseNativeMediaPick()) return null;

  const result = await OpenChamberMedia.pickMedia({ limit });
  if (result.cancelled) return [];

  const files: File[] = [];
  for (const file of result.files) {
    const response = await fetch(Capacitor.convertFileSrc(file.path));
    if (!response.ok) {
      throw new Error(`Native media fetch failed (${response.status})`);
    }
    const blob = await response.blob();
    files.push(new File([blob], file.name, { type: file.mimeType }));
  }
  return files;
}
