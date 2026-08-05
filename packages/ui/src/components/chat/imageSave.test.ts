import { afterEach, describe, expect, mock, test } from 'bun:test';

const runtimeFetchMock = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
  status: 200,
  headers: { 'content-type': 'image/png' },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => false,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => null,
}));

mock.module('@capacitor/core', () => ({
  Capacitor: {
    isPluginAvailable: () => false,
  },
  registerPlugin: () => ({
    saveImage: async () => undefined,
  }),
}));

mock.module('./imageSource', () => ({
  resolveImageSource: (source: string) => {
    if (source.startsWith('file://') || source.startsWith('/')) {
      return { kind: 'runtime-file', source, path: source.replace(/^file:\/\//, '') };
    }
    return { kind: 'direct', source };
  },
  needsRuntimeImageStream: (resolved: { kind: string; path?: string }) => (
    resolved.kind === 'runtime-file' && Boolean(resolved.path)
  ),
  fetchRuntimeImageObjectUrl: async () => 'blob:mock-image',
  releaseRuntimeImageObjectUrl: () => undefined,
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  runtimeFetchMock.mockClear();
  mock.restore();
});

describe('materializeImageBlob', () => {
  test('uses prefetched preview bytes without network work', async () => {
    const prefetchedBlob = new Blob([new Uint8Array([7, 7, 7])], { type: 'image/png' });
    globalThis.fetch = mock(async () => {
      throw new Error('should not fetch when prefetched');
    }) as typeof fetch;

    const { materializeImageBlob } = await import('./imageSave');
    const result = await materializeImageBlob({
      sourceUrl: 'file:///tmp/hidden.png',
      displayUrl: 'blob:display',
      prefetchedBlob,
      filename: 'photo.png',
      mimeType: 'image/png',
    });

    expect(result.blob).toBe(prefetchedBlob);
    expect(result.filename).toBe('photo.png');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  test('reads display URLs through fetch before runtime paths', async () => {
    globalThis.fetch = mock(async () => new Response(new Uint8Array([9, 9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })) as typeof fetch;

    const { materializeImageBlob } = await import('./imageSave');
    const result = await materializeImageBlob({
      sourceUrl: 'file:///tmp/hidden.png',
      displayUrl: 'blob:display',
      filename: 'photo',
      mimeType: 'image/jpeg',
    });

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('photo.jpg');
    expect(result.blob.size).toBe(2);
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });
});
