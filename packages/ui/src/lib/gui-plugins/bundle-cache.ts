import { runtimeFileStore } from '@/lib/runtime-file-store';

type CachedCode = { code: string; token: string };
const key = (runtime: string, id: string) => JSON.stringify(['gui-code-v1', '2.2', runtime, id]);
const group = (runtime: string, id: string) => JSON.stringify(['gui-code', runtime, id]);
export const isGuiRevisionToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Options are arbitrary plugin configuration and must never enter durable storage.
export const guiBundleCache = {
  async read(runtime: string, id: string, signal: AbortSignal): Promise<CachedCode | null> {
    try {
      const blob = await runtimeFileStore.read(key(runtime, id), signal);
      if (!blob) return null;
      const value: unknown = JSON.parse(await blob.text());
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).length !== 2 || typeof entry.code !== 'string' || !entry.code || !isGuiRevisionToken(entry.token)) return null;
      return { code: entry.code, token: entry.token };
    } catch { return null; }
  },
  async write(runtime: string, id: string, value: CachedCode, signal: AbortSignal): Promise<void> {
    try {
      await runtimeFileStore.write(key(runtime, id), new Blob([JSON.stringify({ code: value.code, token: value.token })], { type: 'application/json' }), signal, undefined, group(runtime, id));
    } catch { /* Persistence is optional; the authoritative response remains usable. */ }
  },
};
