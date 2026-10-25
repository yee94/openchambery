/**
 * Yuri project-level configuration service.
 * Stores per-project settings in ~/.config/yuri/<projectId>.json.
 * Migrates from legacy <project>/.yuri/yuri.json.
 */

import type { FilesAPI } from './api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDesktopHomeDirectory } from './desktop';
import { isVSCodeRuntime } from './desktop';
import { sanitizeStarterRefs, type DraftStarterRef } from './draftStarters';
import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

type ProjectRef = { id: string; path: string };

const CONFIG_FILENAME = 'yuri.json';
// LEGACY_PROJECT_CONFIG: legacy per-project config root inside repo.
const LEGACY_CONFIG_DIR = '.yuri';
const USER_PROJECTS_DIR_SEGMENTS = ['.config', 'yuri', 'projects'];

/**
 * Get the runtime Files API if available (Desktop/VSCode).
 */
function getRuntimeFilesAPI(): FilesAPI | null {
  const apis = getRegisteredRuntimeAPIs();
  if (apis?.files) {
    return apis.files;
  }
  return null;
}

interface YuriConfig {
  projectPath?: string;
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  projectActions?: YuriProjectAction[];
  projectActionsPrimaryId?: string;
  draftStarters?: DraftStarterRef[];
}

type YuriProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface YuriProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: YuriProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface YuriProjectActionsState {
  actions: YuriProjectAction[];
  primaryActionId: string | null;
}

const YURI_PROJECT_ACTION_NAME_MAX_LENGTH = 80;
const YURI_PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
const YURI_PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
const YURI_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;

const YURI_ACTION_PLATFORM_SET = new Set<YuriProjectActionPlatform>(['macos', 'linux', 'windows']);

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const getLegacyConfigPath = (projectDirectory: string): string => {
  return joinPath(joinPath(projectDirectory, LEGACY_CONFIG_DIR), CONFIG_FILENAME);
};

const getBaseUrl = (): string => {
  const defaultBaseUrl = import.meta.env.VITE_OPENCODE_URL || '/api';
  if (defaultBaseUrl.startsWith('/')) {
    return defaultBaseUrl;
  }
  return defaultBaseUrl;
};

const postJson = async <T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> => {
  try {
    const response = await runtimeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, data: null };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
};

const mkdirp = async (path: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.createDirectory) {
    try {
      const result = await runtimeFiles.createDirectory(path);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/mkdir`, { path });
  return Boolean(res.ok);
};

const readTextFile = async (path: string): Promise<string | null> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(path);
      const content = typeof result?.content === 'string' ? result.content : '';
      return content;
    } catch {
      return null;
    }
  }

  try {
    const response = await runtimeFetch(`${getBaseUrl()}/fs/read?path=${encodeURIComponent(path)}`,
      {
        // Avoid conditional requests (304 + empty body).
        cache: 'no-store',
      }
    );
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
};

const writeTextFile = async (path: string, content: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.writeFile) {
    try {
      const result = await runtimeFiles.writeFile(path, content);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/write`, { path, content });
  return Boolean(res.ok);
};

const resolveHomeDirectory = async (): Promise<string | null> => {
  // Use server-reported home as the source of truth for user config paths.
  // In some runtimes, window.__YURI_HOME__ can be workspace/project-root
  // scoped, which would incorrectly route writes into the project directory.
  try {
    const response = await runtimeFetch(`${getBaseUrl()}/fs/home`, {
      // Avoid conditional requests (304 + empty body).
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error('Failed to resolve home directory from API');
    }
    const payload = await response.json().catch(() => null) as { home?: unknown } | null;
    const home = typeof payload?.home === 'string' ? payload.home.trim() : '';
    if (home) {
      return normalize(home);
    }
  } catch {
    // fall through
  }

  // Fallback for environments where /api/fs/home is unavailable.
  // VSCode intentionally avoids this because embedded home equals workspace path.
  if (!isVSCodeRuntime()) {
    const desktopHome = await getDesktopHomeDirectory().catch(() => null);
    if (desktopHome && desktopHome.trim().length > 0) {
      return normalize(desktopHome);
    }
  }
  return null;
};

const getUserProjectsDirectory = async (): Promise<string | null> => {
  const home = await resolveHomeDirectory();
  if (!home) {
    return null;
  }
  return USER_PROJECTS_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), home);
};

const resolveConfigProjectId = (project: ProjectRef): string | null => {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  const normalizedProject = projectDirectory ? normalize(projectDirectory) : '';
  if (!normalizedProject) return null;
  return createProjectIdFromPath(normalizedProject) || null;
};

const getUserConfigPath = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  if (!base) {
    return null;
  }
  const safeId = resolveConfigProjectId(project);
  if (!safeId) {
    return null;
  }
  return joinPath(base, `${safeId}.json`);
};

const trimToMaxLength = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
};

const sanitizeProjectActionPlatforms = (value: unknown): YuriProjectActionPlatform[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique: YuriProjectActionPlatform[] = [];
  const seen = new Set<YuriProjectActionPlatform>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim().toLowerCase() as YuriProjectActionPlatform;
    if (!YURI_ACTION_PLATFORM_SET.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
};

const sanitizeProjectActions = (value: unknown): YuriProjectAction[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: YuriProjectAction[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      name?: unknown;
      command?: unknown;
      icon?: unknown;
      platforms?: unknown;
      autoOpenUrl?: unknown;
      openUrl?: unknown;
      desktopOpenSshForward?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = trimToMaxLength(typeof record.name === 'string' ? record.name.trim() : '', YURI_PROJECT_ACTION_NAME_MAX_LENGTH);
    const command = trimToMaxLength(typeof record.command === 'string' ? record.command.trim() : '', YURI_PROJECT_ACTION_COMMAND_MAX_LENGTH);

    if (!id || !name || !command || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const iconRaw = typeof record.icon === 'string' ? record.icon.trim() : '';
    const platforms = sanitizeProjectActionPlatforms(record.platforms);
    const autoOpenUrl = record.autoOpenUrl === true;
    const openUrlRaw = typeof record.openUrl === 'string' ? record.openUrl.trim() : '';
    const openUrl = trimToMaxLength(openUrlRaw, YURI_PROJECT_ACTION_OPEN_URL_MAX_LENGTH);
    const desktopOpenSshForwardRaw = typeof record.desktopOpenSshForward === 'string'
      ? record.desktopOpenSshForward.trim()
      : '';
    const desktopOpenSshForward = trimToMaxLength(
      desktopOpenSshForwardRaw,
      YURI_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH
    );

    sanitized.push({
      id,
      name,
      command,
      icon: iconRaw || null,
      ...(autoOpenUrl ? { autoOpenUrl: true } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(desktopOpenSshForward ? { desktopOpenSshForward } : {}),
      ...(platforms.length > 0 ? { platforms } : {}),
    });
  }

  return sanitized;
};

const sanitizeProjectActionsState = (value: {
  actions?: unknown;
  primaryActionId?: unknown;
} | null | undefined): YuriProjectActionsState => {
  const actions = sanitizeProjectActions(value?.actions);
  const primaryRaw = typeof value?.primaryActionId === 'string' ? value.primaryActionId.trim() : '';
  const primaryActionId = primaryRaw && actions.some((entry) => entry.id === primaryRaw)
    ? primaryRaw
    : null;

  return {
    actions,
    primaryActionId,
  };
};

/**
 * Read the config for a project.
 * Returns null if file doesn't exist or is invalid.
 */
async function readYuriConfig(project: ProjectRef): Promise<YuriConfig | null> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return null;
  }

  const configPath = await getUserConfigPath(project);

  const readText = async (path: string): Promise<string | null> => {
    // Keep behavior consistent with other helpers.
    const text = await readTextFile(path);
    if (text === null) {
      return null;
    }
    return text;
  };

  const parseConfig = (text: string | null): YuriConfig | null => {
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as YuriConfig;
    } catch {
      return null;
    }
  };

  // 1) Prefer new per-user config.
  if (configPath) {
    const existing = parseConfig(await readText(configPath));
    if (existing) {
      return existing;
    }
  }

  // 2) Migrate legacy <project>/.yuri/yuri.json.
  // LEGACY_PROJECT_CONFIG: migrate project-local yuri.json -> ~/.config/yuri/projects/<projectId>.json
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const legacyConfig = parseConfig(await readText(legacyPath));
  if (!legacyConfig) {
    return null;
  }

  // Best-effort write + delete legacy.
  try {
    const wrote = await writeYuriConfig(project, legacyConfig);
    if (wrote) {
      await deleteLegacyYuriConfig(projectDirectory);
    }
  } catch {
    // Ignore migration failures; still return legacy content.
  }

  return legacyConfig;
}

/**
 * Write the per-user config for a project.
 *
 * Server owns `version` and `scheduledTasks` keys; client reads them via their
 * dedicated route and never round-trips them through this config write path to
 * avoid a read-then-write race clobbering a concurrent server update.
 */
async function writeYuriConfig(
  project: ProjectRef,
  config: YuriConfig
): Promise<boolean> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return false;
  }

  const configDir = await getUserProjectsDirectory();
  const configPath = await getUserConfigPath(project);
  if (!configDir || !configPath) {
    return false;
  }

  try {
    const okDir = await mkdirp(configDir);
    if (!okDir) {
      return false;
    }

    const existingRaw = await readTextFile(configPath);
    let existing: Record<string, unknown> = {};
    if (typeof existingRaw === 'string' && existingRaw.trim()) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }

    const serverOwned: Record<string, unknown> = {};
    if (existing.version !== undefined) serverOwned.version = existing.version;
    if (existing.scheduledTasks !== undefined) serverOwned.scheduledTasks = existing.scheduledTasks;

    const content = JSON.stringify({
      ...existing,
      ...config,
      ...serverOwned,
      projectPath: normalize(projectDirectory),
    }, null, 2);
    return await writeTextFile(configPath, content);
  } catch (error) {
    console.error('Failed to write yuri config:', error);
    return false;
  }
}

/**
 * Update specific keys in the config, preserving other values.
 */
async function updateYuriConfig(
  project: ProjectRef,
  updates: Partial<YuriConfig>
): Promise<boolean> {
  const existing = await readYuriConfig(project) || {};
  const merged = { ...existing, ...updates };
  return writeYuriConfig(project, merged);
}

/**
 * Get worktree setup commands from config.
 */
export async function getWorktreeSetupCommands(project: ProjectRef): Promise<string[]> {
  const config = await readYuriConfig(project);
  return config?.['setup-worktree'] ?? [];
}

export async function saveWorktreeSetupCommands(project: ProjectRef, commands: string[]): Promise<boolean> {
  const filtered = commands.filter((cmd) => cmd.trim().length > 0);
  return updateYuriConfig(project, { 'setup-worktree': filtered });
}

export async function getWorktreeSetupWaitEnabled(project: ProjectRef): Promise<boolean> {
  const config = await readYuriConfig(project);
  return config?.['setup-worktree-wait'] === true;
}

export async function saveWorktreeSetupWaitEnabled(project: ProjectRef, enabled: boolean): Promise<boolean> {
  return updateYuriConfig(project, { 'setup-worktree-wait': enabled });
}

/**
 * Get this project's pinned draft welcome starters.
 */
export async function getProjectDraftStarters(project: ProjectRef): Promise<DraftStarterRef[]> {
  const config = await readYuriConfig(project);
  return sanitizeStarterRefs(config?.draftStarters);
}

export async function saveProjectDraftStarters(project: ProjectRef, starters: DraftStarterRef[]): Promise<boolean> {
  return updateYuriConfig(project, { draftStarters: sanitizeStarterRefs(starters) });
}

export async function getProjectActionsState(project: ProjectRef): Promise<YuriProjectActionsState> {
  const config = await readYuriConfig(project);
  return sanitizeProjectActionsState({
    actions: config?.projectActions,
    primaryActionId: config?.projectActionsPrimaryId,
  });
}

export async function saveProjectActionsState(
  project: ProjectRef,
  value: YuriProjectActionsState
): Promise<boolean> {
  const sanitized = sanitizeProjectActionsState({
    actions: value.actions,
    primaryActionId: value.primaryActionId,
  });

  return updateYuriConfig(project, {
    projectActions: sanitized.actions,
    projectActionsPrimaryId: sanitized.primaryActionId ?? undefined,
  });
}

/**
 * Substitute variables in a command string.
 * Supported variables:
 * - $ROOT_PROJECT_PATH: The root project directory path
 * - $ROOT_WORKTREE_PATH: Legacy alias for $ROOT_PROJECT_PATH
 */
export function substituteCommandVariables(
  command: string,
  variables: { rootWorktreePath: string }
): string {
  return command
    // New preferred name
    .replace(/\$ROOT_PROJECT_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, variables.rootWorktreePath)
    // Legacy
    .replace(/\$ROOT_WORKTREE_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, variables.rootWorktreePath);
}

async function deleteLegacyYuriConfig(projectDirectory: string): Promise<void> {
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const runtimeFiles = getRuntimeFilesAPI();

  if (runtimeFiles?.delete) {
    try {
      await runtimeFiles.delete(legacyPath);
      return;
    } catch {
      // fall through
    }
  }

  try {
    await postJson(`${getBaseUrl()}/fs/delete`, { path: legacyPath });
  } catch {
    // ignored
  }
}

export type { ProjectRef };
