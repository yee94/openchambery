/**
 * Cap `openchamber-asset://v/{assetId}` virtual image resolver hooks.
 * Host injects create/append/finish/cancel. Without host → unavailable.
 * Source: packages/mobile/src/openchamber-virtual-asset.ts
 */

export const LYNX_VIRTUAL_ASSET_SCHEME = 'openchamber-asset';
export const LYNX_VIRTUAL_ASSET_MIME_MAX_LENGTH = 128;

export const normalizeLynxVirtualAssetMime = (mimeType: unknown): string | null => {
  if (typeof mimeType !== 'string') return null;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized.length > LYNX_VIRTUAL_ASSET_MIME_MAX_LENGTH) return null;
  if (normalized.includes('\n') || normalized.includes('\r') || normalized.includes('\0')) return null;
  if (!normalized.startsWith('image/')) return null;
  if (!/^image\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/i.test(normalized)) return null;
  return normalized;
};

export const lynxVirtualAssetUrl = (assetId: string): string | null => {
  const id = assetId.trim();
  if (id.length < 8 || id.length > 80) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `${LYNX_VIRTUAL_ASSET_SCHEME}://v/${encodeURIComponent(id)}`;
};

export type LynxVirtualAssetCreateResult = {
  assetId: string;
  url: string;
};

export type LynxVirtualAssetBinder = {
  create: (options: { assetId: string; mime: string }) => Promise<LynxVirtualAssetCreateResult>;
  append: (options: { assetId: string; chunk: string }) => Promise<void>;
  finish: (options: { assetId: string }) => Promise<void>;
  cancel: (options: { assetId: string }) => Promise<void>;
};

export type LynxVirtualAssetResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable'; reason: 'no-host' }
  | { status: 'failed'; error: string };

export type LynxVirtualAssetAdapter = {
  inject: (binder: LynxVirtualAssetBinder | null) => void;
  isAvailable: () => boolean;
  create: (options: { assetId: string; mime: string }) => Promise<LynxVirtualAssetResult<LynxVirtualAssetCreateResult>>;
  append: (options: { assetId: string; chunk: string }) => Promise<LynxVirtualAssetResult<void>>;
  finish: (options: { assetId: string }) => Promise<LynxVirtualAssetResult<void>>;
  cancel: (options: { assetId: string }) => Promise<LynxVirtualAssetResult<void>>;
};

export const createLynxVirtualAssetAdapter = (): LynxVirtualAssetAdapter => {
  let binder: LynxVirtualAssetBinder | null = null;

  const run = async <T>(fn: (b: LynxVirtualAssetBinder) => Promise<T>): Promise<LynxVirtualAssetResult<T>> => {
    if (!binder) return { status: 'unavailable', reason: 'no-host' };
    try {
      return { status: 'ok', value: await fn(binder) };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    create: async (options) => {
      const mime = normalizeLynxVirtualAssetMime(options.mime);
      if (!mime) return { status: 'failed', error: 'invalid image mime' };
      const url = lynxVirtualAssetUrl(options.assetId);
      if (!url) return { status: 'failed', error: 'invalid asset id' };
      return run(async (b) => {
        const created = await b.create({ assetId: options.assetId, mime });
        return { assetId: created.assetId, url: created.url || url };
      });
    },
    append: (options) => run(async (b) => {
      await b.append(options);
    }),
    finish: (options) => run(async (b) => {
      await b.finish(options);
    }),
    cancel: (options) => run(async (b) => {
      await b.cancel(options);
    }),
  };
};

/**
 * Host scheme-handler registration contract (Cap WKURLSchemeHandler /
 * Android WebResourceResponse interceptors). LynxView resource providers
 * should register before first paint.
 */
export const LYNX_VIRTUAL_ASSET_SCHEME_HANDLER_NOTES = [
  'iOS: register WKURLSchemeHandler / Lynx resource provider for openchamber-asset.',
  'Android: intercept openchamber-asset:// with streaming WebResourceResponse / Lynx provider.',
  'Headers: X-Content-Type-Options: nosniff; one reader per asset (second beginRead rejected).',
  'URL shape: openchamber-asset://v/{assetId} — no host path, credentials, or filesystem location.',
] as const;

export type LynxVirtualAssetSchemeHandlerBinder = {
  register: () => Promise<void> | void;
  unregister?: () => Promise<void> | void;
};

export type LynxVirtualAssetSchemeRegistry = {
  inject: (binder: LynxVirtualAssetSchemeHandlerBinder | null) => void;
  isRegistered: () => boolean;
  register: () => Promise<{ status: 'ok' } | { status: 'unavailable'; reason: 'no-host' } | { status: 'failed'; error: string }>;
};

export const createLynxVirtualAssetSchemeRegistry = (): LynxVirtualAssetSchemeRegistry => {
  let binder: LynxVirtualAssetSchemeHandlerBinder | null = null;
  let registered = false;
  return {
    inject: (next) => {
      binder = next;
      if (!next) registered = false;
    },
    isRegistered: () => registered && binder !== null,
    register: async () => {
      if (!binder) return { status: 'unavailable', reason: 'no-host' };
      try {
        await binder.register();
        registered = true;
        return { status: 'ok' };
      } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
};
