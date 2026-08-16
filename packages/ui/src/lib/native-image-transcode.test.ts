import { afterEach, describe, expect, test } from 'bun:test';

import {
  convertHeicToJpegViaNative,
  resetNativeImageTranscodeCacheForTests,
} from './native-image-transcode';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString('base64');
const HEIC_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

const defineWindow = (value: unknown): PropertyDescriptor | undefined => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
  return previous;
};

const restoreWindow = (previous: PropertyDescriptor | undefined): void => {
  if (previous) {
    Object.defineProperty(globalThis, 'window', previous);
    return;
  }
  Reflect.deleteProperty(globalThis, 'window');
};

afterEach(() => {
  resetNativeImageTranscodeCacheForTests();
});

describe('convertHeicToJpegViaNative', () => {
  test('returns null for non-HEIC mime without probing Capacitor', async () => {
    const previous = defineWindow({
      Capacitor: {
        isNativePlatform: () => {
          throw new Error('should not probe Capacitor for JPEG');
        },
      },
    });
    try {
      const result = await convertHeicToJpegViaNative(new Blob([JPEG_BYTES], { type: 'image/jpeg' }));
      expect(result).toBeNull();
    } finally {
      restoreWindow(previous);
    }
  });

  test('returns null when Capacitor is absent', async () => {
    const previous = defineWindow({});
    try {
      const result = await convertHeicToJpegViaNative(new Blob([HEIC_BYTES], { type: 'image/heic' }));
      expect(result).toBeNull();
    } finally {
      restoreWindow(previous);
    }
  });

  test('returns a JPEG blob when the native plugin succeeds', async () => {
    const calls: Array<{ data: string; mime: string; quality?: number }> = [];
    const previous = defineWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          OpenChamberMedia: {
            transcode: async (options: { data: string; mime: string; quality?: number }) => {
              calls.push(options);
              return { data: JPEG_BASE64, mime: 'image/jpeg' };
            },
          },
        },
      },
    });
    try {
      const result = await convertHeicToJpegViaNative(new Blob([HEIC_BYTES], { type: 'image/heic' }));
      expect(result).not.toBeNull();
      expect(result!.type).toBe('image/jpeg');
      expect(new Uint8Array(await result!.arrayBuffer())).toEqual(JPEG_BYTES);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.mime).toBe('image/heic');
      expect(calls[0]?.quality).toBe(0.9);
      expect(calls[0]?.data).toBe(Buffer.from(HEIC_BYTES).toString('base64'));
    } finally {
      restoreWindow(previous);
    }
  });

  test('returns null when the native plugin rejects', async () => {
    const previous = defineWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          OpenChamberMedia: {
            transcode: async () => {
              throw new Error('Could not decode HEIC/HEIF image');
            },
          },
        },
      },
    });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const first = await convertHeicToJpegViaNative(new Blob([HEIC_BYTES], { type: 'image/heif' }));
      const second = await convertHeicToJpegViaNative(new Blob([HEIC_BYTES], { type: 'image/heif' }));
      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain('Native HEIC transcode failed');
    } finally {
      console.warn = originalWarn;
      restoreWindow(previous);
    }
  });
});
