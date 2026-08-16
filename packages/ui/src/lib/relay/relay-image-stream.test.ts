import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  NATIVE_RELAY_ASSET_BRIDGE_KEY,
  resetNativeRelayAssetBridgeCacheForTests,
  type NativeRelayAssetBridge,
  type NativeRelayAssetOpenResult,
} from './native-asset-bridge';
import {
  RELAY_IMAGE_IPC_CHUNK_BYTES,
  RELAY_IMAGE_MAX_BYTES,
  RELAY_IMAGE_MAX_CONCURRENT,
  clearAllRelayImageAssets,
  releaseRelayImageDisplayUrl,
  resetRelayImageStreamForTests,
  streamRelayImageDisplayUrl,
} from './relay-image-stream';

type FetchCall = {
  path: string;
  signal?: AbortSignal | null;
};

const fetchCalls: FetchCall[] = [];
let fetchImpl: (path: string, options?: { signal?: AbortSignal; query?: { path?: string } }) => Promise<Response> = async () => {
  throw new Error('fetch not configured');
};

const transportIdentity = { value: 'relay:{"serverId":"srv_test"}' };
const transportListeners = new Set<() => void>();

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, options?: { signal?: AbortSignal; query?: { path?: string } }) => {
    fetchCalls.push({ path, signal: options?.signal ?? null });
    return fetchImpl(path, options);
  },
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => transportIdentity.value,
  subscribeRuntimeEndpointChanged: (callback: () => void) => {
    transportListeners.add(callback);
    return () => {
      transportListeners.delete(callback);
    };
  },
}));

const textEncoder = new TextEncoder();

const streamResponse = (
  chunks: Uint8Array[],
  headers: Record<string, string> = { 'content-type': 'image/png' },
): Response => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
  return new Response(body, { status: 200, headers });
};

const blobResponse = (
  bytes: Uint8Array,
  headers: Record<string, string> = { 'content-type': 'image/jpeg' },
): Response => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Response(new Blob([copy]), { status: 200, headers });
};

type BridgeRecord = {
  open: Array<{ assetId: string; mimeType: string }>;
  writes: Array<{ assetId: string; bytes: number }>;
  ends: string[];
  aborts: Array<{ assetId: string; reason?: string }>;
  releases: string[];
  writeDelayMs: number;
  writeGate: Promise<void> | null;
};

const installBridge = (options: {
  writeDelayMs?: number;
  writeGate?: Promise<void> | null;
  openUrl?: (assetId: string) => string;
  rewriteAssetId?: (assetId: string) => string;
} = {}): { bridge: NativeRelayAssetBridge; record: BridgeRecord } => {
  const record: BridgeRecord = {
    open: [],
    writes: [],
    ends: [],
    aborts: [],
    releases: [],
    writeDelayMs: options.writeDelayMs ?? 0,
    writeGate: options.writeGate ?? null,
  };

  const bridge: NativeRelayAssetBridge = {
    openAsset: async ({ assetId, mimeType }): Promise<NativeRelayAssetOpenResult> => {
      record.open.push({ assetId, mimeType });
      const finalId = options.rewriteAssetId ? options.rewriteAssetId(assetId) : assetId;
      return {
        assetId: finalId,
        url: (options.openUrl ?? ((id) => `openchamber-asset://stream/${id}`))(finalId),
      };
    },
    writeChunk: async (assetId, chunk) => {
      if (record.writeGate) await record.writeGate;
      if (record.writeDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, record.writeDelayMs));
      }
      record.writes.push({ assetId, bytes: chunk.byteLength });
    },
    endAsset: async (assetId) => {
      record.ends.push(assetId);
    },
    abortAsset: async (assetId, reason) => {
      record.aborts.push({ assetId, reason });
    },
    releaseAsset: async (assetId) => {
      record.releases.push(assetId);
    },
  };

  (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY] = bridge;
  return { bridge, record };
};

const uninstallBridge = (): void => {
  delete (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY];
};

const fireTransportChange = (): void => {
  for (const listener of transportListeners) listener();
};

beforeEach(() => {
  fetchCalls.length = 0;
  transportIdentity.value = 'relay:{"serverId":"srv_test"}';
  transportListeners.clear();
  uninstallBridge();
  resetNativeRelayAssetBridgeCacheForTests();
  resetRelayImageStreamForTests();
  fetchImpl = async () => streamResponse([textEncoder.encode('png-bytes')]);
});

afterEach(() => {
  resetRelayImageStreamForTests();
  uninstallBridge();
  resetNativeRelayAssetBridgeCacheForTests();
});

describe('streamRelayImageDisplayUrl without native bridge', () => {
  test('buffers the response body into a blob object URL', async () => {
    const bytes = textEncoder.encode('jpeg-payload');
    fetchImpl = async () => blobResponse(bytes);
    const created: string[] = [];
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      expect(blob).toBeInstanceOf(Blob);
      return url;
    }) as typeof URL.createObjectURL;

    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    try {
      const controller = new AbortController();
      const url = await streamRelayImageDisplayUrl('/tmp/photo.jpg', controller.signal);
      expect(url).toBe('blob:test/0');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.path).toBe('/api/fs/raw');

      releaseRelayImageDisplayUrl(url);
      expect(revoked).toEqual(['blob:test/0']);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test('rejects non-OK responses', async () => {
    fetchImpl = async () => new Response('missing', { status: 404 });
    await expect(streamRelayImageDisplayUrl('/missing.png', new AbortController().signal))
      .rejects.toThrow(/status 404/);
  });
});

/** Wait until background pump has progressed enough for assertions. */
const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

describe('streamRelayImageDisplayUrl with native bridge', () => {
  test('returns virtual URL immediately after open, before the body reader finishes', async () => {
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { record } = installBridge({ writeGate });

    let secondPullStarted = false;
    fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!secondPullStarted) {
            secondPullStarted = true;
            controller.enqueue(textEncoder.encode('chunk'));
            // Hold the stream open so the reader cannot complete before the URL returns.
            return new Promise(() => {});
          }
        },
        cancel() {},
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    const url = await streamRelayImageDisplayUrl('/early.png', new AbortController().signal);

    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    expect(record.open).toHaveLength(1);
    // Reader is still in progress (write gated / second pull blocked); end has not fired.
    expect(record.ends).toHaveLength(0);
    expect(record.writes).toHaveLength(0);

    releaseWrite?.();
    releaseRelayImageDisplayUrl(url);
    await waitFor(() => record.aborts.length + record.releases.length > 0);
  });

  test('opens with MIME, streams bounded chunks, ends, and never exposes host path', async () => {
    const { record } = installBridge();
    const chunkA = textEncoder.encode('AAAA');
    const chunkB = textEncoder.encode('BBBBBB');
    fetchImpl = async () => streamResponse([chunkA, chunkB], { 'content-type': 'image/webp; charset=binary' });

    const url = await streamRelayImageDisplayUrl('/secret/host/path.png', new AbortController().signal);

    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    expect(record.open).toHaveLength(1);
    expect(record.open[0]?.mimeType).toBe('image/webp');
    expect(record.open[0]?.assetId.startsWith('ria_')).toBe(true);
    expect(JSON.stringify(record)).not.toContain('/secret/host/path.png');

    await waitFor(() => record.ends.length === 1 && record.writes.length === 1);
    expect(record.writes.map((w) => w.bytes)).toEqual([10]);
    expect(record.ends).toEqual([record.open[0]!.assetId]);

    releaseRelayImageDisplayUrl(url);
    await waitFor(() =>
      record.aborts.some((a) => a.assetId === record.open[0]!.assetId)
      && record.releases.includes(record.open[0]!.assetId),
    );
  });

  test('uses the authoritative native assetId when open rewrites it', async () => {
    const { record } = installBridge({
      rewriteAssetId: () => 'native-minted-id-abcdef',
    });
    fetchImpl = async () => streamResponse([textEncoder.encode('x')]);

    const url = await streamRelayImageDisplayUrl('/a.png', new AbortController().signal);
    await waitFor(() => record.ends.includes('native-minted-id-abcdef'));
    expect(record.writes[0]?.assetId).toBe('native-minted-id-abcdef');
    expect(record.ends).toEqual(['native-minted-id-abcdef']);
    releaseRelayImageDisplayUrl(url);
  });

  test('defaults non-image content-type to image/png for native open', async () => {
    const { record } = installBridge();
    fetchImpl = async () => streamResponse(
      [textEncoder.encode('raw')],
      { 'content-type': 'application/octet-stream' },
    );
    const url = await streamRelayImageDisplayUrl('/raw.bin', new AbortController().signal);
    expect(record.open[0]?.mimeType).toBe('image/png');
    await waitFor(() => record.ends.length === 1);
    releaseRelayImageDisplayUrl(url);
  });

  test('aborts the native asset when the signal aborts mid-stream', async () => {
    const { record } = installBridge({ writeDelayMs: 30 });
    let pullCount = 0;
    fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(textEncoder.encode('first'));
            return;
          }
          return new Promise(() => {});
        },
        cancel() {},
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    const controller = new AbortController();
    // URL resolves as soon as openAsset succeeds; body pump continues in the background.
    const url = await streamRelayImageDisplayUrl('/slow.png', controller.signal);
    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('user-cancel'));

    await waitFor(() => record.aborts.length >= 1 && record.releases.length >= 1);
  });

  test('applies write backpressure by awaiting bridge.writeChunk before the next flush', async () => {
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { record } = installBridge({ writeGate });

    const tunnelChunk = 64 * 1024;
    const totalChunks = RELAY_IMAGE_IPC_CHUNK_BYTES / tunnelChunk + 1;
    let pulls = 0;
    fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls <= totalChunks) {
            controller.enqueue(new Uint8Array(tunnelChunk).fill(pulls));
            return;
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    // Returns before the gated aggregated write completes.
    const url = await streamRelayImageDisplayUrl('/bp.png', new AbortController().signal);
    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(record.writes).toHaveLength(0);
    releaseWrite?.();
    await waitFor(() => record.writes.length === 2 && record.ends.length === 1);
    expect(record.writes.map((w) => w.bytes)).toEqual([
      RELAY_IMAGE_IPC_CHUNK_BYTES,
      tunnelChunk,
    ]);
    releaseRelayImageDisplayUrl(url);
  });

  test('aborts and releases the native asset when the body exceeds the max byte budget', async () => {
    const { record } = installBridge();
    const huge = new Uint8Array(RELAY_IMAGE_MAX_BYTES + 1);
    fetchImpl = async () => streamResponse([huge]);

    // URL still returns after open; size failure is handled by the background pump.
    const url = await streamRelayImageDisplayUrl('/huge.png', new AbortController().signal);
    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    await waitFor(() => record.aborts.length >= 1 && record.releases.length >= 1);
    expect(record.writes).toHaveLength(0);
    expect(record.ends).toHaveLength(0);
  });

  test('clears in-flight native assets when the runtime transport changes', async () => {
    const { record } = installBridge({ writeDelayMs: 80 });
    fetchImpl = async () => streamResponse([
      textEncoder.encode('chunk-a'),
      textEncoder.encode('chunk-b'),
    ]);

    const url = await streamRelayImageDisplayUrl('/live.png', new AbortController().signal);
    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    transportIdentity.value = 'relay:{"serverId":"srv_other"}';
    fireTransportChange();

    await waitFor(() => record.aborts.length + record.releases.length > 0);
  });

  test('limits concurrent native streams for backpressure', async () => {
    let releaseGate: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { record } = installBridge({ writeGate });

    fetchImpl = async () => streamResponse([textEncoder.encode('x')]);

    const controllers = Array.from({ length: RELAY_IMAGE_MAX_CONCURRENT + 2 }, () => new AbortController());
    const started = controllers.map((c, index) => streamRelayImageDisplayUrl(`/n-${index}.png`, c.signal));

    // After open, URLs resolve while writes remain gated and keep slots inFlight.
    await waitFor(() => record.open.length === RELAY_IMAGE_MAX_CONCURRENT);
    // Extra opens must still wait for a concurrent slot (inFlight not freed until endAsset).
    expect(record.open.length).toBe(RELAY_IMAGE_MAX_CONCURRENT);

    releaseGate?.();
    const urls = await Promise.all(started);
    expect(urls).toHaveLength(RELAY_IMAGE_MAX_CONCURRENT + 2);
    await waitFor(() => record.open.length === RELAY_IMAGE_MAX_CONCURRENT + 2);
    await waitFor(() => record.ends.length === RELAY_IMAGE_MAX_CONCURRENT + 2);
    for (const url of urls) releaseRelayImageDisplayUrl(url);
  });

  test('aggregates 64 KiB tunnel chunks into at most 512 KiB writeChunk calls', async () => {
    const { record } = installBridge();
    const tunnelChunk = 64 * 1024;
    const chunks = Array.from({ length: 10 }, (_, index) => new Uint8Array(tunnelChunk).fill(index + 1));
    fetchImpl = async () => streamResponse(chunks);

    const url = await streamRelayImageDisplayUrl('/agg.png', new AbortController().signal);
    await waitFor(() => record.ends.length === 1 && record.writes.length === 2);
    expect(record.writes.map((w) => w.bytes)).toEqual([
      RELAY_IMAGE_IPC_CHUNK_BYTES,
      2 * tunnelChunk,
    ]);
    expect(record.writes.every((w) => w.bytes <= RELAY_IMAGE_IPC_CHUNK_BYTES)).toBe(true);
    releaseRelayImageDisplayUrl(url);
  });

  test('flushes a trailing remainder before endAsset', async () => {
    const { record } = installBridge();
    const chunks = [
      new Uint8Array(100).fill(1),
      new Uint8Array(250).fill(2),
      new Uint8Array(50).fill(3),
    ];
    fetchImpl = async () => streamResponse(chunks);

    const url = await streamRelayImageDisplayUrl('/tail.png', new AbortController().signal);
    await waitFor(() => record.ends.length === 1);
    expect(record.writes.map((w) => w.bytes)).toEqual([400]);
    expect(record.ends).toHaveLength(1);
    releaseRelayImageDisplayUrl(url);
  });

  test('discards an unflushed IPC buffer when the stream aborts', async () => {
    const { record } = installBridge();
    fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(7));
          return new Promise(() => {});
        },
        cancel() {},
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    };

    const controller = new AbortController();
    const url = await streamRelayImageDisplayUrl('/discard.png', controller.signal);
    expect(url.startsWith('openchamber-asset://stream/')).toBe(true);
    await waitFor(() => record.open.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(record.writes).toHaveLength(0);
    controller.abort(new Error('user-cancel'));

    await waitFor(() => record.aborts.length >= 1 && record.releases.length >= 1);
    expect(record.writes).toHaveLength(0);
    expect(record.ends).toHaveLength(0);
  });
});

describe('native bridge detection', () => {
  test('falls back to blob when the global bridge is incomplete', async () => {
    (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY] = {
      openAsset: () => ({ assetId: 'x', url: 'x' }),
      // missing methods
    };
    const bytes = textEncoder.encode('fallback');
    fetchImpl = async () => blobResponse(bytes);
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = (() => 'blob:fallback') as typeof URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      const url = await streamRelayImageDisplayUrl('/f.png', new AbortController().signal);
      expect(url).toBe('blob:fallback');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe('clearAllRelayImageAssets', () => {
  test('releases tracked blob assets', async () => {
    fetchImpl = async () => blobResponse(textEncoder.encode('z'));
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => 'blob:clear-me') as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    try {
      await streamRelayImageDisplayUrl('/z.png', new AbortController().signal);
      clearAllRelayImageAssets('test');
      expect(revoked).toContain('blob:clear-me');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
