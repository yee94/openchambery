import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

type DesktopInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type DesktopBridgeGlobal = {
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void,
  ) => Promise<() => void>;
};

type DesktopSshRemoteMode = 'managed' | 'external';
type DesktopSshInstallMethod = 'npm' | 'bun' | 'download_release' | 'upload_bundle';
type DesktopSshSecretStore = 'never' | 'settings';

type DesktopSshStoredSecret = {
  enabled: boolean;
  value?: string;
  store: DesktopSshSecretStore;
};

export type DesktopSshPortForwardType = 'local' | 'remote' | 'dynamic';

export type DesktopSshPortForward = {
  id: string;
  enabled: boolean;
  type: DesktopSshPortForwardType;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
};

export type DesktopSshInstance = {
  id: string;
  nickname?: string;
  sshCommand: string;
  sshParsed?: {
    destination: string;
    args: string[];
  };
  connectionTimeoutSec: number;
  remoteOpenchamber: {
    mode: DesktopSshRemoteMode;
    keepRunning: boolean;
    /** Default true: managed remotes start with `--relay-host`. */
    relayHost: boolean;
    preferredPort?: number;
    installMethod: DesktopSshInstallMethod;
    uploadBundleOverSsh: boolean;
  };
  localForward: {
    preferredLocalPort?: number;
    bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0';
  };
  auth: {
    sshPassword?: DesktopSshStoredSecret;
    openchamberPassword?: DesktopSshStoredSecret;
  };
  portForwards: DesktopSshPortForward[];
};

export type DesktopSshInstancesConfig = {
  instances: DesktopSshInstance[];
};

type DesktopSshPhase =
  | 'idle'
  | 'config_resolved'
  | 'auth_check'
  | 'master_connecting'
  | 'remote_probe'
  | 'installing'
  | 'updating'
  | 'server_detecting'
  | 'server_starting'
  | 'forwarding'
  | 'ready'
  | 'degraded'
  | 'error';

export type DesktopSshInstanceStatus = {
  id: string;
  phase: DesktopSshPhase;
  detail?: string;
  localUrl?: string;
  localPort?: number;
  remotePort?: number;
  startedByUs: boolean;
  retryAttempt: number;
  requiresUserAction: boolean;
  errorCode?: string;
  updatedAtMs: number;
};

export type DesktopSshImportCandidate = {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const readString = (obj: Record<string, unknown>, key: string): string | null => {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
};

const readNumber = (obj: Record<string, unknown>, key: string): number | null => {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const readBoolean = (obj: Record<string, unknown>, key: string): boolean | null => {
  const value = obj[key];
  return typeof value === 'boolean' ? value : null;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const getInvoke = (): DesktopInvoke | null => {
  if (!hasDesktopInvoke()) return null;
  return (command, args) => invokeDesktop(command, args) as Promise<unknown>;
};

const parseStoredSecret = (value: unknown): DesktopSshStoredSecret | undefined => {
  if (!isRecord(value)) return undefined;
  const enabled = readBoolean(value, 'enabled') ?? false;
  const rawStore = readString(value, 'store')?.toLowerCase();
  const store: DesktopSshSecretStore = rawStore === 'settings' ? 'settings' : 'never';
  const rawValue = readString(value, 'value');
  return {
    enabled,
    store,
    ...(rawValue ? { value: rawValue } : {}),
  };
};

const parseForwardType = (value: unknown): DesktopSshPortForwardType => {
  return value === 'remote' || value === 'dynamic' ? value : 'local';
};

const parseForward = (value: unknown): DesktopSshPortForward | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  const enabled = readBoolean(value, 'enabled') ?? true;
  const type = parseForwardType(readString(value, 'type'));
  const localHost = readString(value, 'localHost') || readString(value, 'local_host') || undefined;
  const localPort = readNumber(value, 'localPort') ?? readNumber(value, 'local_port') ?? undefined;
  const remoteHost = readString(value, 'remoteHost') || readString(value, 'remote_host') || undefined;
  const remotePort = readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port') ?? undefined;
  return {
    id,
    enabled,
    type,
    ...(localHost ? { localHost } : {}),
    ...(typeof localPort === 'number' ? { localPort } : {}),
    ...(remoteHost ? { remoteHost } : {}),
    ...(typeof remotePort === 'number' ? { remotePort } : {}),
  };
};

const parseInstance = (value: unknown): DesktopSshInstance | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const sshCommand = readString(value, 'sshCommand') || readString(value, 'ssh_command');
  if (!id || !sshCommand) return null;
  const nickname = readString(value, 'nickname');

  const parsedRaw = value.sshParsed;
  const parsed = isRecord(parsedRaw)
    ? {
        destination: readString(parsedRaw, 'destination') || '',
        args: asStringArray(parsedRaw.args),
      }
    : undefined;

  const remoteRaw = isRecord(value.remoteOpenchamber)
    ? value.remoteOpenchamber
    : isRecord(value.remote_openchamber)
      ? value.remote_openchamber
      : {};

  const localRaw = isRecord(value.localForward)
    ? value.localForward
    : isRecord(value.local_forward)
      ? value.local_forward
      : {};

  const authRaw = isRecord(value.auth) ? value.auth : {};

  const rawMode = readString(remoteRaw, 'mode')?.toLowerCase();
  const mode: DesktopSshRemoteMode = rawMode === 'external' ? 'external' : 'managed';

  const rawInstallMethod = readString(remoteRaw, 'installMethod') || readString(remoteRaw, 'install_method');
  const installMethod: DesktopSshInstallMethod =
    rawInstallMethod === 'npm' ||
    rawInstallMethod === 'download_release' ||
    rawInstallMethod === 'upload_bundle'
      ? rawInstallMethod
      : 'bun';

  const bindHostRaw =
    readString(localRaw, 'bindHost') ||
    readString(localRaw, 'bind_host') ||
    '127.0.0.1';
  const bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0' =
    bindHostRaw === 'localhost' || bindHostRaw === '0.0.0.0' ? bindHostRaw : '127.0.0.1';

  const forwardsRaw = Array.isArray(value.portForwards)
    ? value.portForwards
    : Array.isArray(value.port_forwards)
      ? value.port_forwards
      : [];

  const portForwards = forwardsRaw
    .map((item) => parseForward(item))
    .filter((item): item is DesktopSshPortForward => Boolean(item));

  const preferredPort = readNumber(remoteRaw, 'preferredPort') ?? readNumber(remoteRaw, 'preferred_port');
  const preferredLocalPort =
    readNumber(localRaw, 'preferredLocalPort') ?? readNumber(localRaw, 'preferred_local_port');
  const sshPassword = parseStoredSecret(authRaw.sshPassword || authRaw.ssh_password);
  const openchamberPassword = parseStoredSecret(authRaw.openchamberPassword || authRaw.openchamber_password);

  return {
    id,
    ...(nickname ? { nickname } : {}),
    sshCommand,
    ...(parsed && parsed.destination ? { sshParsed: parsed } : {}),
    connectionTimeoutSec:
      readNumber(value, 'connectionTimeoutSec') ??
      readNumber(value, 'connection_timeout_sec') ??
      60,
    remoteOpenchamber: {
      mode,
      keepRunning: readBoolean(remoteRaw, 'keepRunning') ?? readBoolean(remoteRaw, 'keep_running') ?? true,
      relayHost: readBoolean(remoteRaw, 'relayHost') ?? readBoolean(remoteRaw, 'relay_host') ?? true,
      ...(preferredPort ? { preferredPort } : {}),
      installMethod,
      uploadBundleOverSsh:
        readBoolean(remoteRaw, 'uploadBundleOverSsh') ??
        readBoolean(remoteRaw, 'upload_bundle_over_ssh') ??
        false,
    },
    localForward: {
      ...(preferredLocalPort ? { preferredLocalPort } : {}),
      bindHost,
    },
    auth: {
      ...(sshPassword ? { sshPassword } : {}),
      ...(openchamberPassword ? { openchamberPassword } : {}),
    },
    portForwards,
  };
};

const parsePhase = (value: unknown): DesktopSshPhase => {
  switch (value) {
    case 'config_resolved':
    case 'auth_check':
    case 'master_connecting':
    case 'remote_probe':
    case 'installing':
    case 'updating':
    case 'server_detecting':
    case 'server_starting':
    case 'forwarding':
    case 'ready':
    case 'degraded':
    case 'error':
      return value;
    default:
      return 'idle';
  }
};

const parseStatus = (value: unknown): DesktopSshInstanceStatus | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  return {
    id,
    phase: parsePhase(readString(value, 'phase')),
    ...(readString(value, 'detail') ? { detail: readString(value, 'detail') || undefined } : {}),
    ...(readString(value, 'localUrl') || readString(value, 'local_url')
      ? { localUrl: readString(value, 'localUrl') || readString(value, 'local_url') || undefined }
      : {}),
    ...(typeof (readNumber(value, 'localPort') ?? readNumber(value, 'local_port')) === 'number'
      ? { localPort: readNumber(value, 'localPort') ?? readNumber(value, 'local_port') ?? undefined }
      : {}),
    ...(typeof (readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port')) === 'number'
      ? {
          remotePort: readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port') ?? undefined,
        }
      : {}),
    startedByUs: readBoolean(value, 'startedByUs') ?? readBoolean(value, 'started_by_us') ?? false,
    retryAttempt: readNumber(value, 'retryAttempt') ?? readNumber(value, 'retry_attempt') ?? 0,
    requiresUserAction:
      readBoolean(value, 'requiresUserAction') ?? readBoolean(value, 'requires_user_action') ?? false,
    ...(readString(value, 'errorCode') || readString(value, 'error_code')
      ? { errorCode: readString(value, 'errorCode') || readString(value, 'error_code') || undefined }
      : {}),
    updatedAtMs: readNumber(value, 'updatedAtMs') ?? readNumber(value, 'updated_at_ms') ?? Date.now(),
  };
};

const parseImportCandidate = (value: unknown): DesktopSshImportCandidate | null => {
  if (!isRecord(value)) return null;
  const host = readString(value, 'host');
  const source = readString(value, 'source');
  const sshCommand = readString(value, 'sshCommand') || readString(value, 'ssh_command');
  if (!host || !source || !sshCommand) return null;
  return {
    host,
    source,
    sshCommand,
    pattern: readBoolean(value, 'pattern') ?? false,
  };
};

export const createDesktopSshInstance = (id: string, sshCommand: string): DesktopSshInstance => {
  return {
    id,
    sshCommand,
    connectionTimeoutSec: 60,
    remoteOpenchamber: {
      mode: 'managed',
      keepRunning: true,
      relayHost: true,
      installMethod: 'bun',
      uploadBundleOverSsh: false,
    },
    localForward: {
      bindHost: '127.0.0.1',
    },
    auth: {},
    portForwards: [],
  };
};

export const desktopSshInstancesGet = async (): Promise<DesktopSshInstancesConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { instances: [] };
  }

  const raw = await invoke('desktop_ssh_instances_get');
  if (!isRecord(raw)) {
    return { instances: [] };
  }

  const listRaw = Array.isArray(raw.instances)
    ? raw.instances
    : Array.isArray(raw.desktopSshInstances)
      ? raw.desktopSshInstances
      : [];

  const instances = listRaw
    .map((item) => parseInstance(item))
    .filter((item): item is DesktopSshInstance => Boolean(item));

  return { instances };
};

export const desktopSshInstancesSet = async (config: DesktopSshInstancesConfig): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_instances_set', {
    config: {
      instances: config.instances,
    },
  });
};

export const desktopSshImportHosts = async (): Promise<DesktopSshImportCandidate[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_import_hosts');
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseImportCandidate(item))
    .filter((item): item is DesktopSshImportCandidate => Boolean(item));
};

export const desktopSshConnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_connect', { id });
};

export const desktopSshDisconnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_disconnect', { id });
};

export const desktopSshStatus = async (id?: string): Promise<DesktopSshInstanceStatus[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_status', {
    ...(id ? { id } : {}),
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseStatus(item))
    .filter((item): item is DesktopSshInstanceStatus => Boolean(item));
};

export const desktopSshLogs = async (id: string, limit?: number): Promise<string[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_logs', {
    id,
    ...(typeof limit === 'number' ? { limit } : {}),
  });
  if (!Array.isArray(raw)) return [];
  return raw.filter((line): line is string => typeof line === 'string');
};

export const desktopSshLogsClear = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_logs_clear', { id });
};

export type DesktopSshConfigSyncAgentsRoot = {
  fileCount: number;
  bytes: number;
};

export type DesktopSshConfigSyncAuthFile = {
  bytes: number;
};

export type DesktopSshConfigSyncDirection = 'push' | 'pull';

export type DesktopSshConfigSyncSelections = {
  fileGroups: boolean[];
  singleFiles: boolean[];
  directories: boolean[];
  agentsRoot: boolean;
  authFile: boolean;
};

/** Allowlist cardinality from the desktop local-scan IPC (drives default selection arrays). */
export type DesktopSshConfigSyncSelectionShape = {
  fileGroups: number;
  singleFiles: number;
  directories: number;
};

/**
 * Build an all-selected whitelist snapshot from a scan-reported shape.
 * `authFile` stays opt-in (default unchecked); users can enable it in the sync wizard.
 */
export const buildDefaultSyncSelections = (
  shape: DesktopSshConfigSyncSelectionShape,
  options?: { includeAuthFile?: boolean },
): DesktopSshConfigSyncSelections => {
  const fileGroups = Math.max(0, Math.trunc(Number(shape.fileGroups) || 0));
  const singleFiles = Math.max(0, Math.trunc(Number(shape.singleFiles) || 0));
  const directories = Math.max(0, Math.trunc(Number(shape.directories) || 0));
  return {
    fileGroups: Array.from({ length: fileGroups }, () => true),
    singleFiles: Array.from({ length: singleFiles }, () => true),
    directories: Array.from({ length: directories }, () => true),
    agentsRoot: true,
    authFile: options?.includeAuthFile === true,
  };
};

export type DesktopSshConfigSyncPlan = {
  direction?: DesktopSshConfigSyncDirection;
  files: { path: string; bytes: number }[];
  directories: { path: string; fileCount: number; bytes: number }[];
  agentsRoot: DesktopSshConfigSyncAgentsRoot | null;
  /** Provider credentials at `~/.local/share/opencode/auth.json` only. */
  authFile: DesktopSshConfigSyncAuthFile | null;
  deletes: string[];
  totalBytes: number;
  selections?: DesktopSshConfigSyncSelections;
  /** Present on local-scan responses from desktop main (allowlist shape). */
  selectionShape?: DesktopSshConfigSyncSelectionShape;
};

export type DesktopSshConfigSyncPreview = {
  plan: DesktopSshConfigSyncPlan;
  remoteExisting: string[];
  remoteAgentsRootExists: boolean;
  remoteAuthFileExists: boolean;
  selectionShape?: DesktopSshConfigSyncSelectionShape;
};

export type DesktopSshConfigSyncTargetKind = 'ssh' | 'direct' | 'relay';

export type DesktopSshConfigSyncOptions = {
  direction?: DesktopSshConfigSyncDirection;
  selections?: DesktopSshConfigSyncSelections;
  targetKind?: DesktopSshConfigSyncTargetKind;
};

export type DesktopSshSyncRunRecord = {
  syncRunId: string;
  targetId: string;
  stage?: string;
  direction?: DesktopSshConfigSyncDirection;
  startedAt?: string;
  endedAt?: string;
  result?: 'success' | 'failure' | string;
  summary?: { files?: number; directories?: number; deletes?: number; totalBytes?: number };
  error?: string;
};

export type DesktopSshConfigSyncResult = {
  ok: true;
  files: number;
  directories: number;
  deletes: number;
  totalBytes: number;
  /** Present when `~/.agents` was synced; mirrors plan.agentsRoot.fileCount. */
  agentsRoot: { fileCount: number } | null;
  /** Present when provider auth.json was synced; mirrors plan.authFile.bytes. */
  authFile: DesktopSshConfigSyncAuthFile | null;
};

const parseConfigSyncFileEntry = (value: unknown): { path: string; bytes: number } | null => {
  if (!isRecord(value)) return null;
  const pathValue = readString(value, 'path');
  const bytes = readNumber(value, 'bytes');
  if (!pathValue || bytes === null) return null;
  return { path: pathValue, bytes };
};

const parseConfigSyncDirectoryEntry = (
  value: unknown,
): { path: string; fileCount: number; bytes: number } | null => {
  if (!isRecord(value)) return null;
  const pathValue = readString(value, 'path');
  const fileCount = readNumber(value, 'fileCount') ?? readNumber(value, 'file_count');
  const bytes = readNumber(value, 'bytes');
  if (!pathValue || fileCount === null || bytes === null) return null;
  return { path: pathValue, fileCount, bytes };
};

const parseConfigSyncAgentsRoot = (value: unknown): DesktopSshConfigSyncAgentsRoot | null => {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const fileCount = readNumber(value, 'fileCount') ?? readNumber(value, 'file_count');
  const bytes = readNumber(value, 'bytes');
  if (fileCount === null || bytes === null) return null;
  return { fileCount, bytes };
};

const parseConfigSyncAuthFile = (value: unknown): DesktopSshConfigSyncAuthFile | null => {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const bytes = readNumber(value, 'bytes');
  if (bytes === null) return null;
  return { bytes };
};

const parseConfigSyncPlan = (value: unknown): DesktopSshConfigSyncPlan | null => {
  if (!isRecord(value)) return null;
  const filesRaw = Array.isArray(value.files) ? value.files : null;
  const directoriesRaw = Array.isArray(value.directories) ? value.directories : null;
  const deletes = asStringArray(value.deletes);
  const totalBytes = readNumber(value, 'totalBytes') ?? readNumber(value, 'total_bytes');
  if (!filesRaw || !directoriesRaw || totalBytes === null) return null;
  if (!('agentsRoot' in value) && !('agents_root' in value)) return null;

  const files = filesRaw
    .map((item) => parseConfigSyncFileEntry(item))
    .filter((item): item is { path: string; bytes: number } => Boolean(item));
  const directories = directoriesRaw
    .map((item) => parseConfigSyncDirectoryEntry(item))
    .filter((item): item is { path: string; fileCount: number; bytes: number } => Boolean(item));

  if (files.length !== filesRaw.length || directories.length !== directoriesRaw.length) return null;

  const agentsRootRaw = value.agentsRoot ?? value.agents_root;
  const agentsRoot =
    agentsRootRaw == null ? null : parseConfigSyncAgentsRoot(agentsRootRaw);
  if (agentsRootRaw != null && agentsRoot === null) return null;

  // Missing/invalid authFile → null (backward comfort with older payloads).
  const authFileRaw = value.authFile ?? value.auth_file;
  const authFile = authFileRaw == null ? null : parseConfigSyncAuthFile(authFileRaw);
  const direction = value.direction === 'pull' || value.direction === 'push'
    ? value.direction
    : undefined;
  const selectionsRaw = value.selections;
  const selections = isRecord(selectionsRaw)
    ? {
        fileGroups: Array.isArray(selectionsRaw.fileGroups)
          ? selectionsRaw.fileGroups.map((entry) => entry !== false)
          : [],
        singleFiles: Array.isArray(selectionsRaw.singleFiles)
          ? selectionsRaw.singleFiles.map((entry) => entry !== false)
          : [],
        directories: Array.isArray(selectionsRaw.directories)
          ? selectionsRaw.directories.map((entry) => entry !== false)
          : [],
        agentsRoot: selectionsRaw.agentsRoot !== false,
        authFile: selectionsRaw.authFile === true,
      }
    : undefined;
  const selectionShape = parseSelectionShape(value.selectionShape ?? value.selection_shape);

  return {
    files,
    directories,
    agentsRoot,
    authFile,
    deletes,
    totalBytes,
    ...(direction ? { direction } : {}),
    ...(selections ? { selections } : {}),
    ...(selectionShape ? { selectionShape } : {}),
  };
};

const parseSelectionShape = (value: unknown): DesktopSshConfigSyncSelectionShape | null => {
  if (!isRecord(value)) return null;
  const fileGroups = readNumber(value, 'fileGroups') ?? readNumber(value, 'file_groups');
  const singleFiles = readNumber(value, 'singleFiles') ?? readNumber(value, 'single_files');
  const directories = readNumber(value, 'directories');
  if (fileGroups === null || singleFiles === null || directories === null) return null;
  if (fileGroups < 0 || singleFiles < 0 || directories < 0) return null;
  return { fileGroups, singleFiles, directories };
};

const parseConfigSyncPreview = (value: unknown): DesktopSshConfigSyncPreview | null => {
  if (!isRecord(value)) return null;
  const plan = parseConfigSyncPlan(value.plan);
  if (!plan) return null;
  const selectionShape = parseSelectionShape(value.selectionShape ?? value.selection_shape)
    ?? plan.selectionShape
    ?? null;
  return {
    plan,
    remoteExisting: asStringArray(value.remoteExisting ?? value.remote_existing),
    remoteAgentsRootExists:
      readBoolean(value, 'remoteAgentsRootExists')
      ?? readBoolean(value, 'remote_agents_root_exists')
      ?? false,
    remoteAuthFileExists:
      readBoolean(value, 'remoteAuthFileExists')
      ?? readBoolean(value, 'remote_auth_file_exists')
      ?? false,
    ...(selectionShape ? { selectionShape } : {}),
  };
};

const parseConfigSyncResult = (value: unknown): DesktopSshConfigSyncResult | null => {
  if (!isRecord(value)) return null;
  if (readBoolean(value, 'ok') !== true) return null;
  const files = readNumber(value, 'files');
  const directories = readNumber(value, 'directories');
  const deletes = readNumber(value, 'deletes');
  const totalBytes = readNumber(value, 'totalBytes') ?? readNumber(value, 'total_bytes');
  if (files === null || directories === null || deletes === null || totalBytes === null) return null;
  if (!('agentsRoot' in value) && !('agents_root' in value)) return null;

  const agentsRootRaw = value.agentsRoot ?? value.agents_root;
  let agentsRoot: { fileCount: number } | null = null;
  if (agentsRootRaw != null) {
    if (!isRecord(agentsRootRaw)) return null;
    const fileCount =
      readNumber(agentsRootRaw, 'fileCount') ?? readNumber(agentsRootRaw, 'file_count');
    if (fileCount === null) return null;
    agentsRoot = { fileCount };
  }

  const authFileRaw = value.authFile ?? value.auth_file;
  const authFile = authFileRaw == null ? null : parseConfigSyncAuthFile(authFileRaw);

  return { ok: true, files, directories, deletes, totalBytes, agentsRoot, authFile };
};

export const desktopSshSyncOpencodeConfigLocalScan = async (
  options: DesktopSshConfigSyncOptions = {},
): Promise<DesktopSshConfigSyncPlan | null> => {
  const invoke = getInvoke();
  if (!invoke) {
    console.error('[desktopSsh] config sync local scan skipped: desktop IPC bridge is unavailable in this window');
    return null;
  }
  const raw = await invoke('desktop_ssh_sync_opencode_config', {
    stage: 'local',
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.selections ? { selections: options.selections } : {}),
  });
  if (!isRecord(raw)) {
    console.error('[desktopSsh] config sync local scan returned a non-object payload', raw);
    return null;
  }
  const plan = parseConfigSyncPlan(raw.plan);
  if (!plan) {
    console.error('[desktopSsh] config sync local scan plan payload was not recognized', raw);
    return null;
  }
  // Prefer top-level IPC selectionShape (desktop main contract); fall back to plan field.
  const selectionShape = parseSelectionShape(raw.selectionShape ?? raw.selection_shape)
    ?? plan.selectionShape
    ?? null;
  return selectionShape ? { ...plan, selectionShape } : plan;
};

export const desktopSshSyncOpencodeConfigPreview = async (
  id: string,
  options: DesktopSshConfigSyncOptions = {},
): Promise<DesktopSshConfigSyncPreview | null> => {
  const invoke = getInvoke();
  if (!invoke) {
    console.error('[desktopSsh] config sync preview skipped: desktop IPC bridge is unavailable in this window');
    return null;
  }
  const raw = await invoke('desktop_ssh_sync_opencode_config', {
    id,
    ...(options.targetKind ? { targetKind: options.targetKind } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.selections ? { selections: options.selections } : {}),
  });
  const parsed = parseConfigSyncPreview(raw);
  if (!parsed) {
    console.error('[desktopSsh] config sync preview payload was not recognized', raw);
  }
  return parsed;
};

export const desktopSshSyncOpencodeConfigApply = async (
  id: string,
  options: DesktopSshConfigSyncOptions = {},
): Promise<DesktopSshConfigSyncResult | null> => {
  const invoke = getInvoke();
  if (!invoke) {
    console.error('[desktopSsh] config sync apply skipped: desktop IPC bridge is unavailable in this window');
    return null;
  }
  const raw = await invoke('desktop_ssh_sync_opencode_config', {
    id,
    apply: true,
    ...(options.targetKind ? { targetKind: options.targetKind } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.selections ? { selections: options.selections } : {}),
  });
  const parsed = parseConfigSyncResult(raw);
  if (!parsed) {
    console.error('[desktopSsh] config sync apply payload was not recognized', raw);
  }
  return parsed;
};

export const desktopSshSyncRunsList = async (
  id: string,
  options: { targetKind?: DesktopSshConfigSyncTargetKind } = {},
): Promise<DesktopSshSyncRunRecord[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_sync_runs_list', {
    id,
    ...(options.targetKind ? { targetKind: options.targetKind } : {}),
  });
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is DesktopSshSyncRunRecord => (
    isRecord(entry) && typeof entry.syncRunId === 'string' && typeof entry.targetId === 'string'
  ));
};

export const listenDesktopSshStatus = async (
  listener: (status: DesktopSshInstanceStatus) => void,
): Promise<() => Promise<void>> => {
  if (!hasDesktopInvoke()) {
    return async () => {};
  }

  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
  const listen = desktop?.listen;
  if (typeof listen !== 'function') {
    return async () => {};
  }

  const unlisten = await listen('openchamber:ssh-instance-status', (event) => {
    const status = parseStatus(event?.payload);
    if (!status) return;
    listener(status);
  });

  return async () => {
    await unlisten();
  };
};
