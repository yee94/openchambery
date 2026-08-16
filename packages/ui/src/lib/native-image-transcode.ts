type NativeTranscodePlugin = {
  transcode: (options: { data: string; mime: string; quality?: number }) => Promise<{ data?: unknown; mime?: unknown }>;
};

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    OpenChamberMedia?: NativeTranscodePlugin;
  };
};

const HEIC_MIME = new Set(['image/heic', 'image/heif']);
let nativeFailed = false;

const capacitorBridge = (): CapacitorBridge | null => {
  const win = (globalThis as { window?: { Capacitor?: CapacitorBridge } }).window;
  const capacitor = win?.Capacitor;
  return capacitor && typeof capacitor === 'object' ? capacitor : null;
};

const isHeicBlob = (input: Blob): boolean => HEIC_MIME.has((input.type || '').toLowerCase());

const bytesToBase64 = async (input: Blob): Promise<string> => {
  const bytes = new Uint8Array(await input.arrayBuffer());
  // Chunked conversion: one String.fromCharCode spread per 0x8000 slice keeps
  // the argument list bounded (large spreads risk stack limits and are slow).
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

const base64ToJpegBlob = (value: string, mime: string): Blob => {
  const binary = atob(value);
  const copy = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) copy[i] = binary.charCodeAt(i);
  return new Blob([copy], { type: mime });
};

/**
 * Native HEIC → JPEG transcode. Returns null when the native plugin is
 * unavailable (web/desktop) or after a failed probe so callers can fall
 * back to heic2any WASM.
 */
export const convertHeicToJpegViaNative = async (input: Blob): Promise<Blob | null> => {
  if (!isHeicBlob(input) || nativeFailed) return null;
  const capacitor = capacitorBridge();
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return null;
  }
  const transcode = capacitor.Plugins?.OpenChamberMedia?.transcode;
  if (typeof transcode !== 'function') return null;
  try {
    const result = await transcode({
      data: await bytesToBase64(input),
      mime: input.type.toLowerCase(),
      quality: 0.9,
    });
    if (typeof result?.data !== 'string' || !result.data) return null;
    const mime = typeof result.mime === 'string' && result.mime ? result.mime : 'image/jpeg';
    return base64ToJpegBlob(result.data, mime);
  } catch (error) {
    nativeFailed = true;
    console.warn('Native HEIC transcode failed', error);
    return null;
  }
};

export const resetNativeImageTranscodeCacheForTests = (): void => {
  nativeFailed = false;
};
