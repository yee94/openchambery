import { OPENCODE_CONFIG_SYNC_ALLOWLIST } from './constants.js';

/**
 * @typedef {{
 *   fileGroups: boolean[],
 *   singleFiles: boolean[],
 *   directories: boolean[],
 *   agentsRoot: boolean,
 *   authFile: boolean,
 * }} SyncSelections
 */

/**
 * Default: everything selected except authFile (credentials stay opt-in).
 * @param {{ includeAuthFile?: boolean }} [options]
 * @returns {SyncSelections}
 */
export const buildDefaultSyncSelections = (options = {}) => ({
  fileGroups: OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.map(() => true),
  singleFiles: OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles.map(() => true),
  directories: OPENCODE_CONFIG_SYNC_ALLOWLIST.directories.map(() => true),
  agentsRoot: true,
  authFile: options.includeAuthFile === true,
});

/**
 * Normalize a partial selections object against the allowlist shape.
 * @param {Partial<SyncSelections> | null | undefined} raw
 * @param {{ includeAuthFile?: boolean }} [options]
 * @returns {SyncSelections}
 */
export const normalizeSyncSelections = (raw, options = {}) => {
  const defaults = buildDefaultSyncSelections(options);
  if (!raw || typeof raw !== 'object') return defaults;

  const fileGroups = OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.map((_, index) => (
    Array.isArray(raw.fileGroups) ? raw.fileGroups[index] !== false : defaults.fileGroups[index]
  ));
  const singleFiles = OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles.map((_, index) => (
    Array.isArray(raw.singleFiles) ? raw.singleFiles[index] !== false : defaults.singleFiles[index]
  ));
  const directories = OPENCODE_CONFIG_SYNC_ALLOWLIST.directories.map((_, index) => (
    Array.isArray(raw.directories) ? raw.directories[index] !== false : defaults.directories[index]
  ));

  return {
    fileGroups,
    singleFiles,
    directories,
    agentsRoot: raw.agentsRoot !== false,
    authFile: raw.authFile === true,
  };
};

/**
 * Filter a full plan down to the selected allowlist groups.
 * Mutual-exclusion within a fileGroup is preserved (plan already picked a winner).
 * @param {object} plan
 * @param {SyncSelections} selections
 */
export const filterPlanBySelections = (plan, selections) => {
  const selected = normalizeSyncSelections(selections, { includeAuthFile: selections?.authFile === true });
  const selectedFileNames = new Set();
  const selectedDeleteNames = new Set();

  OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.forEach((group, index) => {
    if (!selected.fileGroups[index]) return;
    for (const name of group) {
      selectedFileNames.add(name);
      selectedDeleteNames.add(name);
    }
  });
  OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles.forEach((name, index) => {
    if (!selected.singleFiles[index]) return;
    selectedFileNames.add(name);
  });

  const selectedDirNames = new Set();
  const selectedDirLegacy = new Set();
  OPENCODE_CONFIG_SYNC_ALLOWLIST.directories.forEach((dirSpec, index) => {
    if (!selected.directories[index]) return;
    selectedDirNames.add(dirSpec.path);
    selectedDeleteNames.add(dirSpec.path);
    if (typeof dirSpec.legacy === 'string' && dirSpec.legacy) {
      selectedDirLegacy.add(dirSpec.legacy);
      selectedDeleteNames.add(dirSpec.legacy);
    }
  });

  const files = (Array.isArray(plan?.files) ? plan.files : []).filter((entry) => selectedFileNames.has(entry.path));
  const directories = (Array.isArray(plan?.directories) ? plan.directories : []).filter((entry) => selectedDirNames.has(entry.path));
  const deletes = (Array.isArray(plan?.deletes) ? plan.deletes : []).filter((name) => selectedDeleteNames.has(name) || selectedDirLegacy.has(name));
  const agentsRoot = selected.agentsRoot ? (plan?.agentsRoot ?? null) : null;
  const authFile = selected.authFile ? (plan?.authFile ?? null) : null;

  let totalBytes = 0;
  for (const entry of files) totalBytes += Number(entry.bytes) || 0;
  for (const entry of directories) totalBytes += Number(entry.bytes) || 0;
  if (agentsRoot) totalBytes += Number(agentsRoot.bytes) || 0;
  if (authFile) totalBytes += Number(authFile.bytes) || 0;

  return {
    ...plan,
    files,
    directories,
    deletes,
    agentsRoot,
    authFile,
    totalBytes,
    selections: selected,
  };
};
