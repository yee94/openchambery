/**
 * Cap `OpenChamberMedia` adapter for Lynx (HEIC transcode + Android pickMedia).
 *
 * Contract: packages/mobile/contracts/openchamber-media.mjs
 *   ios:     saveImage, saveFile, transcode
 *   android: transcode, saveImage, saveFile, pickMedia
 *
 * Host injects binders. Without host:
 *   - pickMedia → unavailable (not empty-success / not cancelled)
 *   - transcode → unavailable (caller may fall back to WASM later; we do not)
 *
 * Cap JS sources:
 *   packages/ui/src/lib/native-media-pick.ts
 *   packages/ui/src/lib/native-image-transcode.ts
 */

export const LYNX_NATIVE_MEDIA_PICK_LIMIT = 20;

export const LYNX_MEDIA_CONTRACT = {
  pluginName: 'OpenChamberMedia',
  methods: {
    ios: ['saveImage', 'saveFile', 'transcode'] as const,
    android: ['transcode', 'saveImage', 'saveFile', 'pickMedia'] as const,
  },
} as const;

export type LynxPickedMediaFile = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

export type LynxMediaPickNativeResult = {
  cancelled: boolean;
  files: LynxPickedMediaFile[];
};

export type LynxMediaPickBinder = {
  /** Android Photo Picker. Cap: OpenChamberMedia.pickMedia. */
  pickMedia: (options: { limit?: number }) => Promise<LynxMediaPickNativeResult>;
};

export type LynxHeicTranscodeBinder = {
  /**
   * Cap OpenChamberMedia.transcode — HEIC/HEIF → JPEG (base64 in/out).
   * quality defaults to 0.9 in Cap.
   */
  transcode: (options: {
    data: string;
    mime: string;
    quality?: number;
  }) => Promise<{ data?: unknown; mime?: unknown }>;
};

export type LynxMediaPickResult =
  | { status: 'ok'; files: LynxPickedMediaFile[] }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: 'no-host' | 'platform-unsupported' }
  | { status: 'failed'; error: string };

export type LynxHeicTranscodeResult =
  | { status: 'ok'; data: string; mime: string }
  | { status: 'skipped'; reason: 'not-heic' }
  | { status: 'unavailable'; reason: 'no-host' }
  | { status: 'failed'; error: string };

const HEIC_MIME = new Set(['image/heic', 'image/heif']);

export const isLynxHeicMime = (mime: string | null | undefined): boolean => (
  HEIC_MIME.has((mime || '').toLowerCase())
);

export type LynxMediaAdapter = {
  injectPick: (binder: LynxMediaPickBinder | null) => void;
  injectTranscode: (binder: LynxHeicTranscodeBinder | null) => void;
  canPick: () => boolean;
  canTranscode: () => boolean;
  /**
   * Open host media picker. No host → unavailable (never empty-ok).
   * User cancel → cancelled. Cap Android-only today; Lynx still exposes the
   * inject surface so iOS host may bind later without inventing Capgo.
   */
  pickMedia: (limit?: number) => Promise<LynxMediaPickResult>;
  /**
   * HEIC → JPEG via host. Non-HEIC → skipped. No host → unavailable
   * (do not invent WASM success here).
   */
  transcodeHeic: (input: {
    dataBase64: string;
    mime: string;
    quality?: number;
  }) => Promise<LynxHeicTranscodeResult>;
};

export const createLynxMediaAdapter = (): LynxMediaAdapter => {
  let pickBinder: LynxMediaPickBinder | null = null;
  let transcodeBinder: LynxHeicTranscodeBinder | null = null;

  return {
    injectPick: (next) => {
      pickBinder = next;
    },
    injectTranscode: (next) => {
      transcodeBinder = next;
    },
    canPick: () => pickBinder !== null,
    canTranscode: () => transcodeBinder !== null,
    pickMedia: async (limit = LYNX_NATIVE_MEDIA_PICK_LIMIT): Promise<LynxMediaPickResult> => {
      if (!pickBinder) return { status: 'unavailable', reason: 'no-host' };
      try {
        const result = await pickBinder.pickMedia({
          limit: Math.max(1, Math.min(limit, LYNX_NATIVE_MEDIA_PICK_LIMIT)),
        });
        if (result.cancelled) return { status: 'cancelled' };
        return {
          status: 'ok',
          files: Array.isArray(result.files) ? result.files : [],
        };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    transcodeHeic: async (input): Promise<LynxHeicTranscodeResult> => {
      if (!isLynxHeicMime(input.mime)) {
        return { status: 'skipped', reason: 'not-heic' };
      }
      if (!transcodeBinder) return { status: 'unavailable', reason: 'no-host' };
      try {
        const result = await transcodeBinder.transcode({
          data: input.dataBase64,
          mime: input.mime.toLowerCase(),
          quality: input.quality ?? 0.9,
        });
        if (typeof result?.data !== 'string' || !result.data) {
          return { status: 'failed', error: 'empty transcode payload' };
        }
        const mime = typeof result.mime === 'string' && result.mime
          ? result.mime
          : 'image/jpeg';
        return { status: 'ok', data: result.data, mime };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};

/**
 * Composer attach call-site helper.
 * Surfaces host absence honestly so UI can hide/disable attach — never
 * pretends files were picked.
 */
export const pickLynxComposerAttachments = async (
  adapter: LynxMediaAdapter,
  limit?: number,
): Promise<LynxMediaPickResult> => adapter.pickMedia(limit);
