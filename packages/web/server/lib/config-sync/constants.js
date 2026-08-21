/** Allowlist for mirroring `~/.config/opencode` (non-session) across sync targets. */
export const OPENCODE_CONFIG_SYNC_ALLOWLIST = {
  // Mutually exclusive groups: first existing local file wins; other members are deleted on remote.
  fileGroups: [
    ['config.json', 'opencode.json', 'opencode.jsonc'],
    ['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'],
    ['oh-my-openagent.json', 'oh-my-openagent.jsonc'],
  ],
  singleFiles: ['AGENTS.md', 'cursor-models.json'],
  directories: [
    { path: 'agents', legacy: 'agent' },
    { path: 'commands', legacy: 'command' },
    { path: 'skills', legacy: 'skill' },
    { path: 'snippet' },
    { path: 'snippets' },
    { path: 'plugins', excludeNames: ['node_modules'] },
    { path: '.oh-my-opencode-slim' },
  ],
};

export const OPENCODE_CONFIG_SYNC_BACKUP_DIR = '.openchamber.sync-backup';
/** Backup root for `$HOME/.agents` (outside `~/.agents` so rm -rf does not eat it). */
export const OPENCODE_AGENTS_SYNC_BACKUP_DIR = '.openchamber.sync-backup-agents';
/** Backup root for provider `auth.json` (outside `~/.local/share`). */
export const OPENCODE_AUTH_SYNC_BACKUP_DIR = '.openchamber.sync-backup-auth';

export const OPENCODE_AGENTS_ROOT_PROBE_MARKER = '__AGENTS_ROOT__';
export const OPENCODE_AUTH_FILE_PROBE_MARKER = '__AUTH_FILE__';

export const OPENCODE_CONFIG_SYNC_MAX_BYTES = 512 * 1024 * 1024;
export const OPENCODE_CONFIG_SYNC_MAX_FILES = 20000;

/** Generational backup retention per backup root (newest kept). */
export const OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS = 5;

/** Plan direction. Ticket 02 implements push only; pull reuses the same contract. */
export const SYNC_DIRECTION_PUSH = 'push';
export const SYNC_DIRECTION_PULL = 'pull';
export const SYNC_DIRECTIONS = Object.freeze([SYNC_DIRECTION_PUSH, SYNC_DIRECTION_PULL]);
