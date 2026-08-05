import { Capacitor, registerPlugin } from '@capacitor/core';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';

import {
  fetchRuntimeImageObjectUrl,
  needsRuntimeImageStream,
  releaseRuntimeImageObjectUrl,
  resolveImageSource,
} from './imageSource';

export type ImageSaveTarget = {
  /** Browser-consumable URL currently shown (blob / openchamber-asset / http / data). */
  displayUrl?: string;
  /** Original message source (file://, absolute path, http, data, …). */
  sourceUrl: string;
  filename?: string;
  mimeType?: string;
  effectiveDirectory?: string;
  /**
   * Bytes already available in the UI (e.g. captured from the fullscreen
   * preview img). When set, save never re-fetches network/runtime paths.
   */
  prefetchedBlob?: Blob;
};

export type ImageSaveResult = 'downloaded' | 'saved';

const DEFAULT_FILENAME = 'image.png';
const DEFAULT_MIME = 'image/png';

type OpenChamberMediaPlugin = {
  saveImage: (options: {
    dataBase64: string;
    mimeType?: string;
    filename?: string;
  }) => Promise<void>;
};

const OpenChamberMedia = registerPlugin<OpenChamberMediaPlugin>('OpenChamberMedia');

const extensionForMime = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() || DEFAULT_MIME;
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/png') return 'png';
  const subtype = normalized.split('/')[1];
  return subtype && /^[a-z0-9.+-]+$/i.test(subtype) ? subtype : 'png';
};

const sanitizeFilename = (value: string | undefined, mimeType: string): string => {
  const fallback = `image.${extensionForMime(mimeType)}`;
  const raw = (value || '').trim() || fallback;
  const base = raw.split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, '_').replace(/^\.+/, '');
  if (!cleaned) return fallback;
  if (!/\.[a-z0-9]{1,8}$/i.test(cleaned)) {
    return `${cleaned}.${extensionForMime(mimeType)}`;
  }
  return cleaned;
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
      return;
    }
    reject(new Error('Failed to encode image'));
  };
  reader.onerror = () => reject(reader.error ?? new Error('Failed to encode image'));
  reader.readAsDataURL(blob);
});

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const dataUrl = await blobToDataUrl(blob);
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

const fetchBlobFromUrl = async (url: string, signal?: AbortSignal): Promise<Blob> => {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`);
  }
  return response.blob();
};

/**
 * Read pixels already decoded into an HTMLImageElement (fullscreen / thumbnail
 * that is on screen). Avoids re-hitting the runtime file path when the preview
 * is already loaded.
 */
export const blobFromImageElement = async (
  image: HTMLImageElement,
  mimeType = DEFAULT_MIME,
): Promise<Blob | null> => {
  if (!image.naturalWidth || !image.naturalHeight) return null;

  const src = image.currentSrc || image.src;
  if (src && (/^(?:blob:|data:|openchamber-asset:)/i.test(src) || /^https?:/i.test(src) || /^\/api(?=\/|[?#]|$)/.test(src))) {
    try {
      const blob = await fetchBlobFromUrl(src);
      if (blob.size > 0) return blob;
    } catch {
      // Fall through to canvas capture for same-origin / decoded bitmaps.
    }
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const type = mimeType.startsWith('image/') ? mimeType : DEFAULT_MIME;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((next) => resolve(next), type === 'image/jpg' ? 'image/jpeg' : type);
    });
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
};

const materializeFromRuntimePath = async (
  path: string,
  signal?: AbortSignal,
): Promise<Blob> => {
  let objectUrl = '';
  try {
    objectUrl = await fetchRuntimeImageObjectUrl(path, signal ?? new AbortController().signal);
    return await fetchBlobFromUrl(objectUrl, signal);
  } finally {
    if (objectUrl) {
      releaseRuntimeImageObjectUrl(objectUrl);
    }
  }
};

export const materializeImageBlob = async (
  target: ImageSaveTarget,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; mimeType: string }> => {
  const effectiveDirectory = target.effectiveDirectory ?? '';
  let blob: Blob | null = null;

  if (target.prefetchedBlob && target.prefetchedBlob.size > 0) {
    blob = target.prefetchedBlob;
  }

  // Prefer the URL already driving the visible <img> (blob / virtual asset).
  // This is a local/memory read, not a second host download when the preview
  // is already resolved.
  const displayUrl = target.displayUrl?.trim();
  if (!blob && displayUrl) {
    try {
      blob = await fetchBlobFromUrl(displayUrl, signal);
    } catch {
      blob = null;
    }
  }

  if (!blob) {
    const source = target.sourceUrl.trim();
    if (!source) {
      throw new Error('Image source is empty');
    }

    if (/^(?:data|blob):/i.test(source) || /^https?:/i.test(source) || /^\/api(?=\/|[?#]|$)/.test(source)) {
      blob = await fetchBlobFromUrl(source, signal);
    } else {
      const resolved = resolveImageSource(source, effectiveDirectory);
      if (needsRuntimeImageStream(resolved)) {
        try {
          blob = await materializeFromRuntimePath(resolved.path, signal);
        } catch {
          const response = await runtimeFetch('/api/fs/raw', {
            method: 'GET',
            cache: 'no-store',
            query: { path: resolved.path },
            signal,
          });
          if (!response.ok) {
            throw new Error(`Image source request failed with status ${response.status}`);
          }
          blob = await response.blob();
        }
      } else {
        blob = await fetchBlobFromUrl(resolved.source, signal);
      }
    }
  }

  if (!blob || blob.size <= 0) {
    throw new Error('Image is empty');
  }

  const mimeType = (
    target.mimeType
    || (blob.type && blob.type.startsWith('image/') ? blob.type : '')
    || DEFAULT_MIME
  ).split(';')[0].trim() || DEFAULT_MIME;

  return {
    blob,
    filename: sanitizeFilename(target.filename, mimeType),
    mimeType,
  };
};

const isNativeMediaAvailable = (): boolean => {
  if (!isCapacitorApp() || typeof Capacitor === 'undefined') return false;
  return Capacitor.isPluginAvailable('OpenChamberMedia');
};

/**
 * Save an image via the best available surface:
 * - Capacitor: native gallery write (OpenChamberMedia)
 * - VS Code: native save dialog
 * - desktop/web: browser download (share is not used for "save to photos")
 */
export const saveImageToDevice = async (
  target: ImageSaveTarget,
  signal?: AbortSignal,
): Promise<ImageSaveResult> => {
  const { blob, filename, mimeType } = await materializeImageBlob(target, signal);

  if (isNativeMediaAvailable()) {
    const dataBase64 = await blobToBase64(blob);
    await OpenChamberMedia.saveImage({ dataBase64, mimeType, filename });
    return 'saved';
  }

  if (isVSCodeRuntime()) {
    const vscode = getRegisteredRuntimeAPIs()?.vscode;
    if (vscode?.saveImage) {
      const dataUrl = await blobToDataUrl(blob);
      await vscode.saveImage({ fileName: filename, dataUrl });
      return 'saved';
    }
  }

  downloadBlob(blob, filename);
  return 'downloaded';
};
