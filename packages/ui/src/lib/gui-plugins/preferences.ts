import { instanceScopedStorageKey } from '@/lib/instanceScopedStorage';

export const guiPreferencesKey = (runtimeKey: string) => instanceScopedStorageKey('gui-plugins.disabled', runtimeKey);

export function readDisabledPlugins(storage: Pick<Storage, 'getItem'>, key: string): readonly string[] {
  const text = storage.getItem(key);
  if (text === null) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === 'string')) {
    throw new Error('Invalid GUI plugin enable-state');
  }
  return [...new Set(parsed)];
}

/** Write first: a failed persistent write must not appear to change enable-state. */
export function writePluginEnabled(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, id: string, enabled: boolean) {
  const disabled = new Set(readDisabledPlugins(storage, key));
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  const next = [...disabled];
  storage.setItem(key, JSON.stringify(next));
  return next;
}
