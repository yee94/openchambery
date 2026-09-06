import { describe, expect, test } from 'vitest';

import {
  createLynxVirtualAssetAdapter,
  lynxVirtualAssetUrl,
  normalizeLynxVirtualAssetMime,
} from './virtualAsset';

describe('virtual asset hooks', () => {
  test('url + mime contract', () => {
    expect(lynxVirtualAssetUrl('asset-001')).toBe('openchamber-asset://v/asset-001');
    expect(lynxVirtualAssetUrl('short')).toBeNull();
    expect(normalizeLynxVirtualAssetMime('image/png')).toBe('image/png');
    expect(normalizeLynxVirtualAssetMime('text/plain')).toBeNull();
  });

  test('no host → unavailable', async () => {
    const adapter = createLynxVirtualAssetAdapter();
    expect(await adapter.create({ assetId: 'asset-001', mime: 'image/png' })).toEqual({
      status: 'unavailable',
      reason: 'no-host',
    });
  });

  test('host create returns url', async () => {
    const adapter = createLynxVirtualAssetAdapter();
    adapter.inject({
      create: async ({ assetId }) => ({ assetId, url: `openchamber-asset://v/${assetId}` }),
      append: async () => undefined,
      finish: async () => undefined,
      cancel: async () => undefined,
    });
    const result = await adapter.create({ assetId: 'asset-00123', mime: 'image/png' });
    expect(result.status).toBe('ok');
  });
});
