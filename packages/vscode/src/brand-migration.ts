import type { ConfigurationTarget, WorkspaceConfiguration } from 'vscode';

const keys = ['apiUrl', 'opencodeBinary'] as const;
type Level = 'globalValue' | 'workspaceValue';

// Explicit, read-only legacy input. Remove after the documented migration window.
export const LEGACY_CONFIGURATION_SECTION = 'openchamber';

export async function importLegacyConfiguration(
  source: Pick<WorkspaceConfiguration, 'inspect'>,
  destination: Pick<WorkspaceConfiguration, 'inspect' | 'update'>,
  levels: Array<{ field: Level; target: ConfigurationTarget }>,
) {
  const result = { imported: 0, skipped: 0, failed: 0 };
  for (const key of keys) {
    const current = destination.inspect<unknown>(key);
    // Any explicit Yuri value wins, including an intentional empty string.
    if (current && [current.globalValue, current.workspaceValue, current.workspaceFolderValue].some(value => value !== undefined)) {
      result.skipped++;
      continue;
    }
    const legacy = source.inspect<unknown>(key);
    // Import the effective explicit value once, at its original winning scope.
    for (const { field, target } of [...levels].reverse()) {
      const value = legacy?.[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !isValidSetting(key, value)) {
        result.failed++;
        break;
      }
      try {
        await destination.update(key, value, target);
        result.imported++;
      } catch {
        // Keep successful independent writes and all legacy values; retry is safe.
        result.failed++;
      }
      break;
    }
  }
  return result;
}

function isValidSetting(key: typeof keys[number], value: string): boolean {
  if (key !== 'apiUrl' || value === '') return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
