import path from 'node:path';

import {
  OPENCODE_AGENTS_ROOT_PROBE_MARKER,
  OPENCODE_AGENTS_SYNC_BACKUP_DIR,
  OPENCODE_AUTH_FILE_PROBE_MARKER,
  OPENCODE_AUTH_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS,
} from './constants.js';

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * JSON.stringify yields bare double quotes, which terminate the surrounding
 * shell double-quoted string in inventory lines. Escape them so the assembled
 * SYNC_INVENTORY payload stays valid JSON after sh evaluation.
 * @param {string} value
 */
const jsonShellEscape = (value) => JSON.stringify(value).replace(/"/g, '\\"');

/**
 * Sanitize syncRunId for use as a single path segment under backup roots.
 * @param {string} syncRunId
 */
export const sanitizeSyncRunIdForPath = (syncRunId) => {
  const trimmed = String(syncRunId || '').trim();
  if (!trimmed) throw new Error('syncRunId is required for generational backup');
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('syncRunId contains unsupported characters for backup paths');
  }
  return trimmed;
};

/**
 * Emit POSIX lines that create `<$backupVar>/<syncRunId>` as `$runVar` and prune older generations.
 * Does not wipe the entire backup root — only replaces the current run dir and
 * deletes generations beyond the retention limit (failed runs keep their scene).
 *
 * @param {{ backupVar: string, runVar: string, quotedRunId: string, generations: number }} args
 * @returns {string[]}
 */
const generationalBackupSetupLines = ({ backupVar, runVar, quotedRunId, generations }) => [
  `mkdir -p "$${backupVar}"`,
  `${runVar}="$${backupVar}"/${quotedRunId}`,
  `rm -rf -- "$${runVar}"`,
  `mkdir -p "$${runVar}"`,
  `(cd "$${backupVar}" && ls -1t 2>/dev/null | awk 'NR>${generations} {print}' | while IFS= read -r old; do`,
  '  [ -n "$old" ] || continue',
  `  [ "$old" = ${quotedRunId} ] && continue`,
  `  rm -rf -- "$${backupVar}/$old"`,
  'done) || true',
];

/**
 * Build the remote POSIX prepare script: generational backup, delete stale counterparts, print SYNC_READY.
 * Backups land under `<backupRoot>/<syncRunId>/…`. Older generations beyond
 * {@link OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS} are pruned; prepare no longer
 * `rm -rf`s the entire backup root at start.
 *
 * @param {{ files: { path: string }[], directories: { path: string }[], deletes: string[], agentsRoot?: { fileCount: number, bytes: number } | null, authFile?: { bytes: number } | null }} plan
 * @param {{ syncRunId: string, generations?: number }} options
 * @returns {string}
 */
export const buildRemoteSyncPrepareScript = (plan, options) => {
  const syncRunId = sanitizeSyncRunIdForPath(options?.syncRunId);
  const generations = Number.isFinite(options?.generations) && Number(options.generations) > 0
    ? Math.trunc(Number(options.generations))
    : OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS;
  const backupDir = OPENCODE_CONFIG_SYNC_BACKUP_DIR;
  const directoryDeleteNames = new Set();
  for (const dirSpec of OPENCODE_CONFIG_SYNC_ALLOWLIST.directories) {
    directoryDeleteNames.add(dirSpec.path);
    if (typeof dirSpec.legacy === 'string' && dirSpec.legacy) {
      directoryDeleteNames.add(dirSpec.legacy);
    }
  }

  const quotedRunId = shellQuote(syncRunId);
  const lines = [
    'set -e',
    'CFG="$HOME/.config/opencode"',
    'mkdir -p "$CFG"',
    `BK="$CFG/${backupDir}"`,
    ...generationalBackupSetupLines({
      backupVar: 'BK',
      runVar: 'RUN_BK',
      quotedRunId,
      generations,
    }),
  ];

  const backupPaths = [
    ...(Array.isArray(plan?.files) ? plan.files.map((entry) => entry.path) : []),
    ...(Array.isArray(plan?.directories) ? plan.directories.map((entry) => entry.path) : []),
  ];

  for (const rel of backupPaths) {
    const quoted = shellQuote(rel);
    const dirname = path.posix.dirname(rel);
    const quotedDir = shellQuote(dirname === '.' ? '' : dirname);
    lines.push(`if [ -e "$CFG"/${quoted} ]; then`);
    if (dirname === '.' || dirname === '') {
      lines.push('  mkdir -p "$RUN_BK"');
    } else {
      lines.push(`  mkdir -p "$RUN_BK"/${quotedDir}`);
    }
    lines.push(`  cp -a "$CFG"/${quoted} "$RUN_BK"/${quoted}`);
    lines.push('fi');
  }

  for (const rel of Array.isArray(plan?.deletes) ? plan.deletes : []) {
    const quoted = shellQuote(rel);
    if (directoryDeleteNames.has(rel)) {
      lines.push(`rm -rf -- "$CFG"/${quoted}`);
    } else {
      lines.push(`rm -f -- "$CFG"/${quoted}`);
    }
  }

  if (plan?.agentsRoot) {
    lines.push(`AGENTS_BK="$HOME/${OPENCODE_AGENTS_SYNC_BACKUP_DIR}"`);
    lines.push(...generationalBackupSetupLines({
      backupVar: 'AGENTS_BK',
      runVar: 'AGENTS_RUN_BK',
      quotedRunId,
      generations,
    }));
    lines.push('if [ -e "$HOME/.agents" ]; then');
    lines.push('  cp -a "$HOME/.agents" "$AGENTS_RUN_BK/agents"');
    lines.push('fi');
    lines.push('rm -rf -- "$HOME/.agents"');
  }

  if (plan?.authFile) {
    lines.push(`AUTH_BK="$HOME/${OPENCODE_AUTH_SYNC_BACKUP_DIR}"`);
    lines.push(...generationalBackupSetupLines({
      backupVar: 'AUTH_BK',
      runVar: 'AUTH_RUN_BK',
      quotedRunId,
      generations,
    }));
    lines.push('if [ -e "$HOME/.local/share/opencode/auth.json" ]; then');
    lines.push('  cp -a "$HOME/.local/share/opencode/auth.json" "$AUTH_RUN_BK/auth.json"');
    lines.push('fi');
  }

  lines.push("printf 'SYNC_READY\\n'");
  return lines.join('\n');
};

/**
 * Build the remote existence probe script for the sync preview.
 * @param {string[]} uniqueProbePaths
 * @returns {string}
 */
export const buildRemoteSyncProbeScript = (uniqueProbePaths) => {
  const lines = (Array.isArray(uniqueProbePaths) ? uniqueProbePaths : []).map((rel) => {
    const quoted = shellQuote(rel);
    return `[ -e "$HOME/.config/opencode"/${quoted} ] && printf '%s\\n' ${quoted}`;
  });
  lines.push(
    `[ -e "$HOME/.agents" ] && printf '%s\\n' ${shellQuote(OPENCODE_AGENTS_ROOT_PROBE_MARKER)}`,
  );
  lines.push(
    `[ -e "$HOME/.local/share/opencode/auth.json" ] && printf '%s\\n' ${shellQuote(OPENCODE_AUTH_FILE_PROBE_MARKER)}`,
  );
  lines.push('exit 0');
  return lines.join('\n');
};

/**
 * Finalize script: confirm generational backup dir exists for this syncRunId and print SYNC_DONE.
 * @param {{ syncRunId: string }} options
 */
export const buildRemoteSyncFinalizeScript = (options) => {
  const syncRunId = sanitizeSyncRunIdForPath(options?.syncRunId);
  const quotedRunId = shellQuote(syncRunId);
  return [
    'set -e',
    `BK="$HOME/.config/opencode/${OPENCODE_CONFIG_SYNC_BACKUP_DIR}"/${quotedRunId}`,
    'if [ ! -d "$BK" ]; then',
    "  printf 'SYNC_FINALIZE_MISSING_BACKUP\\n' >&2",
    '  exit 1',
    'fi',
    "printf 'SYNC_DONE\\n'",
  ].join('\n');
};

/**
 * Build a remote inventory script that prints a JSON object describing which
 * allowlist paths exist on the remote (for pull planning). Uses only POSIX sh.
 * Output is a single JSON line prefixed by SYNC_INVENTORY=.
 * @returns {string}
 */
export const buildRemoteSyncInventoryScript = () => {
  const filePaths = [
    ...OPENCODE_CONFIG_SYNC_ALLOWLIST.fileGroups.flat(),
    ...OPENCODE_CONFIG_SYNC_ALLOWLIST.singleFiles,
  ];
  const dirPaths = OPENCODE_CONFIG_SYNC_ALLOWLIST.directories.map((entry) => entry.path);
  const lines = [
    'set -e',
    'CFG="$HOME/.config/opencode"',
    'FILES=""',
    'DIRS=""',
  ];
  for (const rel of filePaths) {
    const quoted = shellQuote(rel);
    lines.push(`if [ -f "$CFG"/${quoted} ]; then`);
    lines.push(`  BYTES="$(wc -c < "$CFG"/${quoted} | tr -d ' ')"`);
    lines.push(`  FILES="$FILES{\\"path\\":${jsonShellEscape(rel)},\\"bytes\\":$BYTES},"`);
    lines.push('fi');
  }
  for (const rel of dirPaths) {
    const quoted = shellQuote(rel);
    lines.push(`if [ -d "$CFG"/${quoted} ]; then`);
    lines.push(`  COUNT="$(find "$CFG"/${quoted} -type f ! -path '*/node_modules/*' ! -name '*.backup' 2>/dev/null | wc -l | tr -d ' ')"`);
    lines.push(`  BYTES="$(find "$CFG"/${quoted} -type f ! -path '*/node_modules/*' ! -name '*.backup' -exec wc -c {} + 2>/dev/null | awk 'END{print $1+0}')"`);
    lines.push(`  DIRS="$DIRS{\\"path\\":${jsonShellEscape(rel)},\\"fileCount\\":$COUNT,\\"bytes\\":$BYTES},"`);
    lines.push('fi');
  }
  lines.push('AGENTS="null"');
  lines.push('if [ -d "$HOME/.agents" ]; then');
  lines.push("  ACOUNT=\"$(find \"$HOME/.agents\" -type f ! -path '*/node_modules/*' ! -name '*.backup' 2>/dev/null | wc -l | tr -d ' ')\"");
  lines.push("  ABYTES=\"$(find \"$HOME/.agents\" -type f ! -path '*/node_modules/*' ! -name '*.backup' -exec wc -c {} + 2>/dev/null | awk 'END{print $1+0}')\"");
  lines.push('  AGENTS="{\\"fileCount\\":$ACOUNT,\\"bytes\\":$ABYTES}"');
  lines.push('fi');
  lines.push('AUTH="null"');
  lines.push('if [ -f "$HOME/.local/share/opencode/auth.json" ]; then');
  lines.push('  AUBYTES="$(wc -c < "$HOME/.local/share/opencode/auth.json" | tr -d \' \')"');
  lines.push('  AUTH="{\\"bytes\\":$AUBYTES}"');
  lines.push('fi');
  lines.push('FILES="${FILES%,}"');
  lines.push('DIRS="${DIRS%,}"');
  lines.push('printf \'SYNC_INVENTORY={"files":[%s],"directories":[%s],"agentsRoot":%s,"authFile":%s}\\n\' "$FILES" "$DIRS" "$AGENTS" "$AUTH"');
  lines.push('exit 0');
  return lines.join('\n');
};

/**
 * Stream a remote tar.gz of selected config paths to stdout.
 * @param {{ files?: { path: string }[], directories?: { path: string }[] }} plan
 */
export const buildRemoteConfigTarScript = (plan) => {
  const entries = [
    ...(Array.isArray(plan?.files) ? plan.files.map((entry) => entry.path) : []),
    ...(Array.isArray(plan?.directories) ? plan.directories.map((entry) => entry.path) : []),
  ];
  if (entries.length === 0) {
    return "printf '' ; exit 0";
  }
  const quotedEntries = entries.map((rel) => shellQuote(rel)).join(' ');
  return [
    'set -e',
    'CFG="$HOME/.config/opencode"',
    `cd "$CFG" && tar -h -czf - ${quotedEntries}`,
  ].join('\n');
};

export const buildRemoteAgentsTarScript = () => [
  'set -e',
  'cd "$HOME" && tar -h -czf - .agents',
].join('\n');

export const buildRemoteAuthTarScript = () => [
  'set -e',
  'cd "$HOME/.local/share/opencode" && tar -h -czf - auth.json',
].join('\n');

export { shellQuote };
