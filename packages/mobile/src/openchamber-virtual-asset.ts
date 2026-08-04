import { registerPlugin } from '@capacitor/core';

/**
 * Capacitor virtual image asset bridge.
 *
 * Progressive host-backed images (e.g. Relay tunnel streams) cannot use
 * blob: object URLs on native WebViews without buffering the full response.
 * This plugin lets the renderer open an opaque one-shot virtual URL and push
 * Base64 chunks; native iOS/Android serve those bytes to `<img>` / CSS through
 * a custom scheme handler (iOS WKURLSchemeHandler, Android request intercept).
 *
 * Web / hosted H5 does not register this plugin — keep object-URL behavior there.
 *
 * ## Bridge API (UI consumers)
 *
 * ```ts
 * const { assetId, url } = await OpenChamberVirtualAsset.create({
 *   assetId: crypto.randomUUID(), // opaque, [A-Za-z0-9_-]{8,80}
 *   mime: 'image/png',
 * });
 * // use `url` as img.src immediately (progressive)
 * await OpenChamberVirtualAsset.append({ assetId, chunk: base64Part });
 * await OpenChamberVirtualAsset.finish({ assetId });
 * // or OpenChamberVirtualAsset.cancel({ assetId }) on abort
 * ```
 *
 * URL shape: `openchamber-asset://v/{assetId}` — no host path, credentials, or
 * filesystem location. Native enforces TTL, concurrency, byte ceilings, and
 * queue backpressure; cancel/finish/close and expiry free all queues.
 *
 * MIME is image-only (aligned with Electron): `image/*` strict subtype form, max 128
 * chars, no CR/LF/NUL. Scheme responses include `X-Content-Type-Options: nosniff`.
 * One reader per asset — a second open is rejected so the shared queue is not sharded.
 */
export type VirtualAssetCreateOptions = {
  /** Opaque one-use id; native rejects unknown/duplicate ids. */
  assetId: string;
  /**
   * Response Content-Type for the virtual image request.
   * Must be a valid `image/*` type (see {@link normalizeVirtualAssetMime}).
   */
  mime: string;
};

export type VirtualAssetCreateResult = {
  assetId: string;
  /** Browser-consumable virtual URL for this asset. */
  url: string;
};

export type VirtualAssetAppendOptions = {
  assetId: string;
  /** Base64-encoded raw bytes (standard or URL-safe, with optional padding). */
  chunk: string;
};

export type VirtualAssetIdOptions = {
  assetId: string;
};

export interface OpenChamberVirtualAssetPlugin {
  create(options: VirtualAssetCreateOptions): Promise<VirtualAssetCreateResult>;
  append(options: VirtualAssetAppendOptions): Promise<void>;
  finish(options: VirtualAssetIdOptions): Promise<void>;
  cancel(options: VirtualAssetIdOptions): Promise<void>;
}

export const OpenChamberVirtualAsset = registerPlugin<OpenChamberVirtualAssetPlugin>(
  'OpenChamberVirtualAsset',
);

/** Shared scheme contract used by the TS wrapper and native handlers. */
export const VIRTUAL_ASSET_SCHEME = 'openchamber-asset';

/** Max length for a normalized image MIME (matches Electron / native stores). */
export const VIRTUAL_ASSET_MIME_MAX_LENGTH = 128;

/**
 * Normalize and validate image-only MIME for virtual assets.
 * Same rules as Electron `normalizeImageMimeType` and native iOS/Android create.
 *
 * @returns lowercase `image/*` type, or `null` when rejected
 */
export function normalizeVirtualAssetMime(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized.length > VIRTUAL_ASSET_MIME_MAX_LENGTH) return null;
  if (normalized.includes('\n') || normalized.includes('\r') || normalized.includes('\0')) {
    return null;
  }
  // Virtual assets are image-only; reject non-image types to limit abuse surface.
  if (!normalized.startsWith('image/')) return null;
  // Basic subtype form: type/subtype with optional +suffix, no parameters.
  if (!/^image\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/i.test(normalized)) return null;
  return normalized;
}

export function virtualAssetUrl(assetId: string): string {
  return `${VIRTUAL_ASSET_SCHEME}://v/${encodeURIComponent(assetId)}`;
}
