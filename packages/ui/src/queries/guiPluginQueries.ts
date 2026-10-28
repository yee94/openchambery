import { queryOptions } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

let activeBundles = 0;
const pendingBundles: Array<() => void> = [];

const acquireBundleSlot = (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
  const abort = () => {
    const index = pendingBundles.indexOf(start);
    if (index !== -1) pendingBundles.splice(index, 1);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  const start = () => {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) { abort(); return; }
    activeBundles++;
    resolve(() => {
      activeBundles--;
      pendingBundles.shift()?.();
    });
  };
  if (signal.aborted) { abort(); return; }
  if (activeBundles < 2) start();
  else {
    pendingBundles.push(start);
    signal.addEventListener('abort', abort, { once: true });
  }
});

export const guiInventoryOptions = (transport: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'inventory'],
  queryFn: async ({ signal }) => {
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    return (await api.plugin.list(undefined, { signal })).data;
  },
  staleTime: 5_000,
  retry: 1,
});

export const guiBundleOptions = (transport: string, id: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'bundle', id],
  queryFn: async ({ signal }) => {
    const identity = getRuntimeTransportIdentity();
    const generation = getRuntimeGeneration();
    const runtime = getRuntimeKey();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (identity !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) {
        throw new DOMException('Plugin runtime ended', 'AbortError');
      }
    };
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    assertCurrent();
    const release = await acquireBundleSlot(signal);
    try {
      assertCurrent();
      const result = await api.plugin.gui({ id }, { signal });
      assertCurrent();
      return result.data;
    } finally { release(); }
  },
  staleTime: Infinity,
  retry: 1,
});
