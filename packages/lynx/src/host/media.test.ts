import { describe, expect, test } from 'vitest';

import {
  LYNX_MEDIA_CONTRACT,
  createLynxMediaAdapter,
  isLynxHeicMime,
  pickLynxComposerAttachments,
} from './media';

describe('LynxMediaAdapter', () => {
  test('contract mirrors Cap OpenChamberMedia methods', () => {
    expect(LYNX_MEDIA_CONTRACT.pluginName).toBe('OpenChamberMedia');
    expect(LYNX_MEDIA_CONTRACT.methods.android).toContain('pickMedia');
    expect(LYNX_MEDIA_CONTRACT.methods.ios).toContain('transcode');
  });

  test('pickMedia without host is unavailable (not empty ok)', async () => {
    const adapter = createLynxMediaAdapter();
    expect(adapter.canPick()).toBe(false);
    expect(await pickLynxComposerAttachments(adapter)).toEqual({
      status: 'unavailable',
      reason: 'no-host',
    });
  });

  test('pickMedia cancel vs ok', async () => {
    const adapter = createLynxMediaAdapter();
    adapter.injectPick({
      pickMedia: async () => ({ cancelled: true, files: [] }),
    });
    expect(await adapter.pickMedia()).toEqual({ status: 'cancelled' });
    adapter.injectPick({
      pickMedia: async () => ({
        cancelled: false,
        files: [{ path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 12 }],
      }),
    });
    expect(await adapter.pickMedia()).toEqual({
      status: 'ok',
      files: [{ path: '/tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 12 }],
    });
  });

  test('HEIC transcode without host is unavailable; non-heic skipped', async () => {
    const adapter = createLynxMediaAdapter();
    expect(isLynxHeicMime('image/heic')).toBe(true);
    expect(await adapter.transcodeHeic({
      dataBase64: 'xx',
      mime: 'image/jpeg',
    })).toEqual({ status: 'skipped', reason: 'not-heic' });
    expect(await adapter.transcodeHeic({
      dataBase64: 'xx',
      mime: 'image/heic',
    })).toEqual({ status: 'unavailable', reason: 'no-host' });

    adapter.injectTranscode({
      transcode: async () => ({ data: 'jpeg64', mime: 'image/jpeg' }),
    });
    expect(await adapter.transcodeHeic({
      dataBase64: 'heic64',
      mime: 'image/heic',
    })).toEqual({ status: 'ok', data: 'jpeg64', mime: 'image/jpeg' });
  });
});
