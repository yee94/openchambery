/**
 * OpenCode plugin routes (`plugin.list`, `plugin.check`, `plugin.update`).
 *
 * Every call is scoped to a directory Location. A failed read throws; it is
 * never an empty inventory that the settings page could treat as "all loaded".
 */

import type { PluginInfo } from '@opencode/client';
import { opencodeClient } from './client';

export type PluginRuntimeSource =
  /** `target` is the config string verbatim (no implicit `@latest`). */
  | { kind: 'package'; target: string; version: string | null; outdated: boolean; updating: boolean }
  /** A loaded plugin reports its entrypoint file; one that failed to load reports the configured path. */
  | { kind: 'local'; path: string }
  | { kind: 'builtin' };

export type PluginRuntimeState = { kind: 'active' } | { kind: 'failed'; error: string; ref: string | null };

export interface PluginRuntimeInfo {
  source: PluginRuntimeSource;
  state: PluginRuntimeState;
}

const locationOf = (directory: string | null): { location: { directory: string } } | undefined => {
  const trimmed = directory?.trim();
  return trimmed ? { location: { directory: trimmed } } : undefined;
};

const pluginApi = () => {
  const api = opencodeClient.getSdkClient().plugin;
  if (!api?.list || !api.check || !api.update) {
    throw new Error('OpenCode plugin status is not available');
  }
  return api;
};

const toSource = (source: PluginInfo['source']): PluginRuntimeSource => {
  switch (source.type) {
    case 'package':
      return {
        kind: 'package',
        target: source.target,
        version: source.version ?? null,
        outdated: source.outdated === true,
        updating: source.updating === true,
      };
    case 'local':
      return { kind: 'local', path: source.path };
    case 'builtin':
    case 'sdk':
      return { kind: 'builtin' };
    default: {
      const unexpected: never = source;
      throw new Error(`Unexpected plugin source: ${JSON.stringify(unexpected)}`);
    }
  }
};

const toState = (state: PluginInfo['state']): PluginRuntimeState => {
  if (state.status === 'active') return { kind: 'active' };
  if (state.status === 'failed') return { kind: 'failed', error: state.error, ref: state.ref ?? null };
  const unexpected: never = state;
  throw new Error(`Unexpected plugin state: ${JSON.stringify(unexpected)}`);
};

const toRuntimeInfo = (info: PluginInfo): PluginRuntimeInfo => ({
  source: toSource(info.source),
  state: toState(info.state),
});

const asInventory = (data: unknown): PluginRuntimeInfo[] => {
  if (!Array.isArray(data)) throw new Error('OpenCode plugin status payload is invalid');
  return data.map((item) => toRuntimeInfo(item as PluginInfo));
};

/** Every plugin OpenCode activated (or failed to) for the directory's Location. */
export async function listPluginRuntime(
  directory: string | null,
  signal?: AbortSignal,
): Promise<PluginRuntimeInfo[]> {
  const response = await pluginApi().list(locationOf(directory), signal ? { signal } : undefined);
  return asInventory(response?.data);
}

/**
 * Re-checks package plugins and returns the refreshed inventory. OpenCode only
 * marks mutable specs outdated; an exact version never is. Throws on failure
 * so the caller can keep the inventory already on screen.
 */
export async function checkPluginUpdates(
  directory: string | null,
  signal?: AbortSignal,
): Promise<PluginRuntimeInfo[]> {
  const response = await pluginApi().check(locationOf(directory), signal ? { signal } : undefined);
  return asInventory(response?.data);
}

/**
 * Reinstalls one package plugin at the newest release its spec allows and
 * reloads it. Config is not written, so a pinned spec is not rewritten.
 * One target per request.
 */
export async function updatePluginPackage(
  directory: string | null,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  const spec = target.trim();
  if (!spec) throw new Error('plugin.update requires a target');
  await pluginApi().update({
    ...locationOf(directory),
    targets: [spec],
  }, signal ? { signal } : undefined);
}

export function pluginOperationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'plugin operation failed';
}
